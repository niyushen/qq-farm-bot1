<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import { BUCKETS, formatCount, formatDuration, formatHours, sortFacilities, useRanchClock, useRanchLoader, useRanchUnmountReset } from '@/components/ranch/ranch-shared'
import RanchCareerPanel from '@/components/ranch/RanchCareerPanel.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import RunLogCard from '@/components/RunLogCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { getPlatformLabel, useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { formatCouponAmount, formatGoldAmount, formatGoldBeanAmount } from '@/utils/number-format'
import { ranchActionIcons, ranchActionLabels, ranchTodayOperations } from '@/utils/ranch-display'

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, currentAccountConnected: isOnline } = storeToRefs(useStatusStore())
const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('overview')
const { remainingSeconds } = useRanchClock()
useRanchUnmountReset()

const facilities = computed<any[]>(() => sortFacilities(state.value?.facilities || []))
const pens = computed(() => facilities.value.filter(f => f.ranch))
const animals = computed(() => pens.value.flatMap(f => (f.ranch.animals || []).map((animal: any) => ({ animal, pen: f.name }))))
const capacity = computed(() => pens.value.reduce((sum, f) => sum + (Number(f.ranch.capacity) || 0), 0))
const shelvesReady = computed(() => pens.value.reduce((sum, f) => sum + f.ranch.shelves.filter((s: any) => s.canCollect).length, 0))
const hazards = computed(() => pens.value.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0))
const blocked = computed(() => animals.value.filter(({ animal }) => animal.grassBlocked).length)

const displayName = computed(() => {
  const account = currentAccount.value
  const live = String(status.value?.accountId || '') === String(account?.id || '') ? status.value?.status?.name : ''
  return live || account?.nick || account?.name || '我的牧场'
})
const avatar = computed(() => {
  const account = currentAccount.value
  const live = String(status.value?.accountId || '') === String(account?.id || '') ? String(status.value?.status?.avatarUrl || '').trim() : ''
  return live || String(account?.avatar || '').trim()
})
const failedAvatar = ref('')
watch(avatar, () => failedAvatar.value = '')
const platformLabel = computed(() => getPlatformLabel(currentAccount.value?.platform))

const expPercent = computed(() => {
  const needed = Number(state.value?.neededExp) || 0
  return needed > 0 ? Math.min(100, Math.max(0, Number(state.value.currentExp) / needed * 100)) : 100
})
const expHint = computed(() => {
  if (!state.value?.neededExp)
    return '牧场已满级'
  const remain = Number(state.value.neededExp) - Number(state.value.currentExp)
  return `距 Lv.${Number(state.value.level) + 1} 还差 ${formatCount(Math.max(0, remain))} 经验`
})

const currency = (id: number) => state.value?.currencies?.find((c: any) => Number(c.id) === id)
// 金券 / 点券 / 金豆豆 / 松果：单位与农场首页的金额口径保持一致（万、亿自动缩写）。
const ASSET_FORMATTERS: Record<number, (value: unknown) => string> = {
  1007: formatGoldAmount,
  1002: formatCouponAmount,
  1005: formatGoldBeanAmount,
  1008: formatGoldAmount,
}
const assetTiles = computed(() => [1007, 1002, 1005, 1008]
  .map(id => currency(id))
  .filter(Boolean)
  .map((item: any) => ({
    ...item,
    display: (ASSET_FORMATTERS[Number(item.id)] || formatCount)(item.count),
  })))
function formatGain(value: unknown) {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0)
    return '0'
  return `${num > 0 ? '+' : ''}${formatCount(num)}`
}
// 图鉴等级走独立请求：ranch store 的 load 会整体替换 state，不能在概览页重复加载。
const book = ref<any>(null)
async function loadBook() {
  if (!currentAccountId.value) {
    book.value = null
    return
  }
  try {
    const response = await api.get('/api/ranch', { params: { view: 'illustrated' }, headers: { 'x-account-id': String(currentAccountId.value) }, timeout: 45000, skipErrorToast: true } as any)
    book.value = response.data?.ok ? (response.data.data?.book || null) : null
  }
  catch {
    book.value = null
  }
}
watch(currentAccountId, () => void loadBook(), { immediate: true })

const stockTiles = computed(() => {
  // 桌面副本同款四项：普通/有机罐头剩余时长，图鉴显示当前点数（不是等级）。
  const cans = BUCKETS.map(bucket => ({
    key: bucket.id,
    label: Number(bucket.id) === 7004 ? '有机罐头时长' : '普通罐头时长',
    image: Number(bucket.id) === 7004 ? '/game-config/ranch-icons/can-organic.png' : '/game-config/ranch-icons/can-normal.png',
    value: formatHours(state.value?.buckets?.find((b: any) => Number(b.id) === bucket.id)?.seconds ?? 0),
  }))
  const normalPoints = book.value?.normal?.progress
  const giantPoints = book.value?.giant?.score
  return [
    ...cans,
    // 图标用 resource-icons 里 219px 的官方大图，ranch-icons 里 32px 的小图在卡片上发糊。
    { key: 'book-normal', label: '普通图鉴', image: '/game-config/resource-icons/illustrated-crop.png', value: normalPoints != null ? formatCount(normalPoints) : '—' },
    { key: 'book-giant', label: '巨大图鉴', image: '/game-config/resource-icons/illustrated-mutant.png', value: giantPoints != null ? formatCount(giantPoints) : '—' },
  ]
})

const todo = computed(() => [
  { key: 'harvest', label: '可收获', icon: 'i-carbon-wheat text-amber-500', value: animals.value.filter(({ animal }) => animal.canHarvest).length + shelvesReady.value },
  { key: 'produce', label: '可生产', icon: 'i-carbon-circle-dash text-green-500', value: animals.value.filter(({ animal }) => animal.canProduce).length },
  { key: 'feed', label: '可喂养', icon: 'i-carbon-flash text-sky-500', value: animals.value.filter(({ animal }) => animal.canFeed).length },
  { key: 'clean', label: '待清理', icon: 'i-carbon-clean text-violet-400', value: hazards.value },
])

const todayOperations = computed(() => {
  const current = status.value
  if (String(current?.accountId || '') !== String(currentAccountId.value || '') || !current?.ranchOperations)
    return []
  const operations = current.ranchOperations
  return [
    { key: 'harvest', label: '收获', count: operations.harvest },
    { key: 'produce', label: '生产', count: operations.produce },
    { key: 'helpFarming', label: '帮忙清理', count: operations.helpFarming },
    { key: 'steal', label: '偷取货架', count: operations.steal },
  ]
})

function facilityMeter(f: any) {
  if (f.state === 2)
    return { text: '待建造', percent: 0 }
  if (f.upgradeState)
    return { text: `升级中 · ${formatDuration(remainingSeconds(f.upgradeEndTime))}`, percent: 0 }
  if (f.ranch)
    return { text: `${f.ranch.count} / ${f.ranch.capacity}`, percent: f.ranch.capacity ? f.ranch.count / f.ranch.capacity * 100 : 0 }
  if (f.feed)
    return { text: `牧草 ${f.feed.count} / ${f.capacity}`, percent: f.capacity ? f.feed.count / f.capacity * 100 : 0 }
  return { text: `容量 ${f.capacity}`, percent: 0 }
}

/* ── 下次检查倒计时 / 今日统计 ─────────────────────────────────────
   位置与农场首页右侧那两栏一致：先倒计时、再今日统计，
   倒计时三环（牧场 / 帮助 / 偷取）来自牧场的每日例程。 */
const now = ref(Date.now())
const ticker = window.setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => window.clearInterval(ticker))

// 与农场首页一致：牧场 / 帮助 / 偷取
const RANCH_CHECKS = [
  { key: 'farm', label: '牧场', icon: 'i-fas-paw', color: '#22c55e' },
  { key: 'help', label: '帮助', icon: 'i-carbon-user-multiple', color: '#3b82f6' },
  { key: 'steal', label: '偷取', icon: 'i-carbon-run', color: '#f97316' },
]

function formatCountdown(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor(seconds % 86400 / 3600)
  const m = Math.floor(seconds % 3600 / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return d > 0 ? `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
}

const checks = computed(() => RANCH_CHECKS.map((item) => {
  const queue = state.value?.nextChecks?.[item.key]
  const remain = Math.max(0, Math.ceil(((Number(queue?.nextAt) || 0) - now.value) / 1000))
  const ready = !!queue?.done && !remain
  const value = !queue
    ? '读取中'
    : !queue.enabled
        ? '未开启'
        : queue.done && !queue.nextAt
          ? '已完成'
          : remain > 0 ? formatCountdown(remain) : '检查中…'
  // 进度环：没有下一次检查时间就按「本轮已完成」画满。
  const progress = queue && queue.enabled ? (queue.nextAt ? Math.min(100, Math.max(0, 100 - remain / Math.max(1, Math.round((Number(queue.nextAt) - Number(queue.lastAt || 0)) / 1000)) * 100)) : 100) : 0
  return { ...item, value, progress: ready ? 100 : progress }
}))

const todayKey = computed(() => {
  const d = new Date(now.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})

const todayExpGained = computed(() => Math.max(0, Number(status.value?.sessionExpGained) || 0))
const todayOps = computed(() => ranchTodayOperations(state.value?.operations, state.value?.operationsDate, todayKey.value))
const operationEntries = computed(() => Object.entries(todayOps.value).filter(([, count]) => Number(count) > 0))

/* ── 今日统计瓦片：先资源今日增减（金券/松果/便便），再固定动作计数（偷取/出售/清理/放蚊子），
   其余动作有记录才出现。样式与同一网格里的其它瓦片完全一致。 ── */
const RANCH_TODAY_CURRENCIES = [
  { id: 1007, label: '金券', icon: 'i-carbon-ticket' },
  { id: 1008, label: '松果', icon: 'i-carbon-tree' },
  { id: 7002, label: '便便', icon: 'i-carbon-recycle' },
] as const
const RANCH_TODAY_ACTIONS = [
  { key: 'steal', label: '偷取' },
  { key: 'sell', label: '出售' },
  { key: 'clean', label: '清理' },
  { key: 'putMosquito', label: '放蚊子' },
] as const

const currencyStatsMap = computed<Record<string, any>>(() => (state.value?.currencyStats || {}))

const todayCurrencyTiles = computed(() => RANCH_TODAY_CURRENCIES.map(({ id, label, icon }) => {
  const day = currencyStatsMap.value[String(id)] || {}
  const baseline = Number(day.baseline) || 0
  const current = Number(day.current) || baseline
  const delta = current - baseline
  return {
    key: `currency-${id}`,
    label,
    image: '',
    icon,
    // 数值不带千分位逗号：和今日统计里的动作次数保持同一视觉口径。
    value: String(Math.abs(delta)),
    title: `今日变动 ${delta >= 0 ? '+' : '-'}${formatCount(Math.abs(delta))}，当前 ${formatCount(current)}`,
  }
}))

const fixedActionTiles = computed(() => RANCH_TODAY_ACTIONS.map(({ key, label }) => ({
  key: `action-${key}`,
  label,
  image: '',
  icon: ranchActionIcons[key] || 'i-carbon-chart-column',
  value: String(todayOps.value[key] ?? 0),
  title: label,
})))

const otherActionTiles = computed(() => {
  const fixedKeys = new Set<string>(RANCH_TODAY_ACTIONS.map(item => item.key))
  return operationEntries.value
    .filter(([key]) => !fixedKeys.has(key))
    .map(([key, val]) => ({
      key: `action-${key}`,
      label: ranchActionLabels[key] || key,
      image: '',
      icon: ranchActionIcons[key] || 'i-carbon-chart-column',
      value: String(val),
      title: ranchActionLabels[key] || key,
    }))
})

const expTile = computed(() => ({
  key: 'today-exp',
  label: '经验',
  image: '',
  icon: 'i-carbon-star-filled',
  value: String(todayExpGained.value),
  title: `今日获得经验 ${formatCount(todayExpGained.value)}`,
}))

/**
 * 今日统计瓦片的展示顺序：金券、经验、便便、松果、出售、偷取、清理、放蚊子。
 *
 * 单独维护这张表而不是依赖上面的拼接顺序——RANCH_TODAY_CURRENCIES /
 * RANCH_TODAY_ACTIONS 是按业务语义分组写的，排版顺序会来回调整，
 * 两者耦合会导致「改一个顺序牵连另几处」。以后调位置只改这一行。
 * 表里没列到的动作（otherActionTiles）自动排在末尾，保持原有相对顺序。
 */
const TODAY_TILE_ORDER = [
  'currency-1007',
  'today-exp',
  'currency-7002',
  'currency-1008',
  'action-sell',
  'action-steal',
  'action-clean',
  'action-putMosquito',
]

const todayTiles = computed(() => {
  const tiles = [expTile.value, ...todayCurrencyTiles.value, ...fixedActionTiles.value, ...otherActionTiles.value]
  const rankOf = (key: string): number => {
    const index = TODAY_TILE_ORDER.indexOf(key)
    return index < 0 ? TODAY_TILE_ORDER.length : index
  }
  // Array.prototype.sort 在 ES2019+ 是稳定排序，同 rank 的条目保持原顺序。
  return tiles.slice().sort((a, b) => rankOf(a.key) - rankOf(b.key))
})
const activeTodayCount = computed(() => todayTiles.value.filter(tile => tile.value !== '0').length)
</script>

<template>
  <div class="page-stack flex flex-col gap-5">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后查看牧场" icon="i-carbon-user-avatar" />
    <RanchGate v-else @retry="refresh">
      <div class="overview-band">
        <div class="overview-grid">
          <!-- 账号：身份、在线状态与牧场等级 -->
          <section class="ov-card ov-account">
            <div class="ov-account__head">
              <div class="ov-avatar" :class="{ 'is-online': isOnline }">
                <img v-if="avatar && avatar !== failedAvatar" :key="avatar" :src="avatar" alt="" @error="failedAvatar = avatar">
                <span v-else class="i-carbon-user-avatar" />
                <i class="ov-avatar__dot" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="ov-account__name-row">
                  <strong class="ov-account__name" :title="displayName">{{ displayName }}</strong>
                  <span class="ov-level">牧场 Lv.{{ state.level }}</span>
                </div>
                <div class="ov-presence">
                  <span class="ov-presence__state" :class="isOnline ? 'is-online' : 'is-offline'">{{ isOnline ? '在线' : '离线' }}</span>
                  <span class="ov-presence__item"><span class="i-carbon-pet-image-o" />饲养 {{ animals.length }} / {{ capacity }}</span>
                  <span v-if="platformLabel" class="ov-presence__item">{{ platformLabel }}</span>
                </div>
              </div>
              <NButton circle quaternary :loading="loading" title="刷新牧场" aria-label="刷新牧场" @click="refresh">
                <template #icon>
                  <span class="i-carbon-renew" />
                </template>
              </NButton>
            </div>

            <div class="ov-exp">
              <div class="ov-exp__labels">
                <span>牧场经验</span>
                <span class="ov-exp__value">
                  {{ formatCount(state.currentExp) }} / {{ state.neededExp ? formatCount(state.neededExp) : '—' }}
                  <b>{{ Math.floor(expPercent) }}%</b>
                </span>
              </div>
              <div class="ov-exp__track">
                <div class="ov-exp__bar" :style="{ width: `${expPercent}%` }" />
              </div>
            </div>

            <div class="ov-account__foot">
              <span>{{ expHint }}</span>
            </div>
          </section>

          <!-- 资产 -->
          <section class="ov-card">
            <h3 class="ov-card__title">
              资产
            </h3>
            <div class="ov-tiles">
              <div v-for="item in assetTiles" :key="item.id" class="ov-tile">
                <span class="ov-tile__label"><img class="ov-tile__img" :src="item.image" alt="">{{ item.name }}</span>
                <strong class="ov-tile__value" :title="formatCount(item.count)">{{ item.display }}</strong>
                <small v-if="(item.sessionGained || 0) !== 0" class="ov-tile__delta" :class="(item.sessionGained || 0) > 0 ? 'is-up' : 'is-down'">
                  本次 {{ formatGain(item.sessionGained) }}
                </small>
                <small v-if="(item.todayGained || 0) !== 0" class="ov-tile__delta" :class="(item.todayGained || 0) > 0 ? 'is-up' : 'is-down'">
                  今日 {{ formatGain(item.todayGained) }}
                </small>
              </div>
            </div>
          </section>

          <!-- 库存：普通/有机罐头时长与普通/巨大图鉴等级（桌面副本同款四项） -->
          <section class="ov-card">
            <h3 class="ov-card__title">
              库存
            </h3>
            <div class="ov-tiles">
              <div v-for="item in stockTiles" :key="item.key" class="ov-tile">
                <span class="ov-tile__label"><img class="ov-tile__img" :src="item.image" alt="">{{ item.label }}</span>
                <strong class="ov-tile__value">{{ item.value }}</strong>
              </div>
            </div>
          </section>
        </div>

        <RanchCareerPanel v-if="state.career" :key="currentAccountId" :career="state.career" />
      </div>

      <div v-if="blocked" class="ranch-alert" role="status">
        <span class="i-carbon-warning-alt" aria-hidden="true" />
        <span>牧草不足，{{ blocked }} 只动物已暂停成长。</span>
        <BaseButton variant="text" size="sm" to="/ranch/personal?tab=facilities">
          去补充牧草
        </BaseButton>
      </div>

      <div class="flex flex-1 flex-col items-stretch gap-6 md:flex-row">
        <!-- 运行日志按账号记录，与农场概览共用 -->
        <RunLogCard />

        <div class="min-w-0 flex flex-col gap-6 md:w-1/4">
          <!-- 下次检查倒计时：与农场首页同位置、同三环布局 -->
          <section class="farm-card rounded-2xl p-5">
            <h3 class="mb-3 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-hourglass" /> <span>下次检查倒计时</span>
            </h3>
            <div class="grid grid-cols-3 gap-2">
              <div
                v-for="check in checks"
                :key="check.key"
                class="min-w-0 flex flex-col items-center text-center"
              >
                <div
                  class="h-18 w-18 flex items-center justify-center rounded-full p-1"
                  :style="{ background: `conic-gradient(${check.color} ${check.progress}%, color-mix(in srgb, ${check.color} 14%, transparent) 0)` }"
                >
                  <div class="h-full w-full flex flex-col items-center justify-center rounded-full bg-white dark:bg-gray-800">
                    <span :class="check.icon" class="text-xl" :style="{ color: check.color }" aria-hidden="true" />
                    <span class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ check.label }}</span>
                  </div>
                </div>
                <div class="mt-1.5 w-full truncate text-sm font-mono font-bold 2xl:text-base" :title="check.value">
                  {{ check.value }}
                </div>
              </div>
            </div>
          </section>

          <!-- 今日统计：资源今日增减 + 牧场动作计数，位置与农场首页一致 -->
          <section class="farm-card rounded-2xl p-5">
            <h3 class="mb-3 flex items-center justify-between gap-2 text-lg font-display font-medium">
              <span class="flex items-center gap-2"><span class="i-carbon-chart-column" /> <span>今日统计</span></span>
              <span class="text-xs text-gray-400 font-normal">{{ activeTodayCount }} 项有记录</span>
            </h3>
            <EmptyState
              v-if="!isOnline"
              bare
              title="账号未登录"
              description="启动账号后显示牧场操作统计"
              icon="i-carbon-connection-signal-off"
            />
            <div v-else class="grid grid-cols-2 gap-2 2xl:gap-3" role="region" aria-label="今日牧场统计">
              <div
                v-for="tile in todayTiles"
                :key="tile.key"
                class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-700/30"
                :title="tile.title"
              >
                <div class="min-w-0 flex items-center gap-2">
                  <span class="select-none text-base text-teal-600 2xl:text-lg" :class="tile.icon || 'i-carbon-chart-column'" />
                  <div class="truncate text-xs text-gray-500 2xl:text-sm" :title="tile.label">
                    {{ tile.label }}
                  </div>
                </div>
                <div class="text-sm font-bold 2xl:text-base">
                  {{ tile.value }}
                </div>
              </div>
            </div>
          </section>

          <section v-if="todayOperations.length" class="farm-card rounded-2xl p-5">
            <h3 class="mb-3 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-chart-column" aria-hidden="true" />今日收益统计
            </h3>
            <dl class="grid grid-cols-2 gap-2">
              <div v-for="item in todayOperations" :key="item.key" class="ranch-todo" :class="{ 'is-zero': !item.count }">
                <dt class="text-xs text-gray-500 dark:text-gray-400">
                  {{ item.label }}
                </dt>
                <dd class="m-0 tabular-nums font-semibold">
                  {{ formatCount(item.count) }}
                </dd>
              </div>
            </dl>
          </section>

          <!-- 待处理 -->
          <section class="farm-card rounded-2xl p-5">
            <header class="ranch-card-head">
              <h3 class="flex items-center gap-2 text-lg font-display font-medium">
                <span class="i-carbon-task" /> <span>待处理</span>
              </h3>
              <BaseButton variant="text" size="sm" to="/ranch/personal">
                管理动物<span class="i-carbon-chevron-right" aria-hidden="true" />
              </BaseButton>
            </header>
            <div class="grid grid-cols-2 gap-2 2xl:gap-3">
              <div v-for="item in todo" :key="item.key" class="ranch-todo" :class="{ 'is-zero': !item.value }">
                <div class="flex items-center gap-2">
                  <span class="select-none text-base" :class="item.icon" />
                  <span class="text-xs text-gray-500">{{ item.label }}</span>
                </div>
                <b>{{ item.value }}</b>
              </div>
            </div>
          </section>

          <!-- 设施 -->
          <section class="farm-card rounded-2xl p-5">
            <h3 class="mb-4 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-building" /> <span>牧场设施</span>
            </h3>
            <div class="ranch-facilities">
              <div v-for="f in facilities" :key="f.id" class="ranch-facility" :class="{ 'is-pending': f.state === 2 }">
                <div class="ranch-facility__row">
                  <span class="ranch-facility__name">{{ f.name }}<small>Lv.{{ f.level }}</small></span>
                  <span class="ranch-facility__value">{{ facilityMeter(f).text }}</span>
                </div>
                <div class="ranch-facility__track" aria-hidden="true">
                  <i :style="{ width: `${Math.min(100, facilityMeter(f).percent)}%` }" />
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </RanchGate>
  </div>
</template>

<style scoped src="@/styles/overview.css"></style>

<style scoped>
.overview-band {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ov-account__head > :deep(.n-button) {
  align-self: flex-start;
}

.ov-tile__img {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

.ranch-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 30%, transparent);
  border-radius: var(--ui-radius-control);
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 13px;
}

.ranch-alert > :last-child {
  margin-left: auto;
}

.ranch-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.ranch-todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  font-variant-numeric: tabular-nums;
}

.ranch-todo b {
  font-size: 15px;
}

.ranch-todo.is-zero {
  opacity: 0.6;
}

.ranch-facilities {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ranch-facility__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.ranch-facility__name {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.ranch-facility__name small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-weight: var(--fw-500);
}

.ranch-facility__value {
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.ranch-facility__track {
  height: 6px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.ranch-facility__track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
  transition: width 0.4s ease;
}

.ranch-facility.is-pending {
  opacity: 0.6;
}
</style>
