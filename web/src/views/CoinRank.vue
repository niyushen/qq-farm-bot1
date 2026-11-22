<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'

interface RankItem {
  id: string
  name: string
  nick: string
  avatar: string
  platform?: string
  running: boolean
  todayGoldEarned: number
  gold: number
  rank: number
}

interface RankData {
  date: string
  updatedAt: number
  totalGoldGained: number
  list: RankItem[]
}

const loading = ref(false)
const data = ref<RankData | null>(null)
const failedAvatars = ref<Set<string>>(new Set())

const medal = {
  1: { label: '冠军', color: '#E3B23C', soft: 'rgba(227, 178, 60, 0.14)', chip: '#F7CE5B', ink: '#6d4e00', icon: 'i-carbon-trophy-filled' },
  2: { label: '亚军', color: '#AEB9C4', soft: 'rgba(174, 185, 196, 0.16)', chip: '#D5DEE6', ink: '#44505c', icon: 'i-carbon-star-filled' },
  3: { label: '季军', color: '#C98256', soft: 'rgba(201, 130, 86, 0.14)', chip: '#E6A876', ink: '#7a3f18', icon: 'i-carbon-star-filled' },
} as const

const topThree = computed(() => (data.value?.list || []).filter(item => item.rank <= 3))
const restList = computed(() => (data.value?.list || []).filter(item => item.rank > 3))

// 领奖台视觉顺序：亚军(2) - 冠军(1) - 季军(3)
const podiumOrder = computed(() => {
  const map = new Map(topThree.value.map(item => [item.rank, item]))
  return [map.get(2), map.get(1), map.get(3)].filter(Boolean) as RankItem[]
})

function formatNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num).toLocaleString('zh-CN') : '0'
}

function formatGain(value: unknown) {
  const num = Number(value)
  if (!Number.isFinite(num))
    return '0'
  const rounded = Math.round(num)
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('zh-CN')}`
}

function formatUpdateTime(ts: number) {
  if (!ts)
    return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function medalOf(rank: number) {
  return medal[rank as 1 | 2 | 3] || medal[3]
}

function avatarFailed(id: string) {
  return failedAvatars.value.has(id)
}

function markAvatarFailed(id: string) {
  const next = new Set(failedAvatars.value)
  next.add(id)
  failedAvatars.value = next
}

function resolveAvatar(item: RankItem) {
  return item.avatar && !avatarFailed(item.id) ? item.avatar : ''
}

async function loadRank(silent = false) {
  if (!silent)
    loading.value = true
  try {
    const res = await api.get('/api/coin-rank', { skipErrorToast: true } as any)
    if (res.data?.ok && res.data?.data) {
      data.value = res.data.data as RankData
    }
  }
  catch {
    // 静默失败：保留上一次成功的榜单数据
  }
  finally {
    loading.value = false
  }
}

onMounted(() => loadRank())

// 金币增量实时变化，每 30 秒静默刷新一次榜单
useIntervalFn(() => loadRank(true), 30000)
</script>

<template>
  <div class="page-stack space-y-4">
    <!-- 概览条 -->
    <div class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div class="flex items-center gap-3">
          <div class="h-11 w-11 flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-yellow-500 text-white shadow-sm">
            <span class="i-carbon-trophy text-2xl" />
          </div>
          <div>
            <h2 class="text-gray-800 font-bold dark:text-gray-100">
              今日农场金币增加排行榜
            </h2>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              按今日各账号金币增加量实时排名（忽略升级等花费）· 仅展示前十 · {{ data?.date || '—' }}
              <span v-if="data?.updatedAt"> · {{ formatUpdateTime(data.updatedAt) }} 更新</span>
            </p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="text-right">
            <div class="text-xs text-gray-500 dark:text-gray-400">全员总增加</div>
            <div class="text-lg text-amber-600 font-bold tabular-nums dark:text-amber-400">
              +{{ formatNumber(data?.totalGoldGained || 0) }}
            </div>
          </div>
          <NButton size="small" secondary :loading="loading" @click="loadRank()">
            <template #icon>
              <span class="i-carbon-renew" />
            </template>
            刷新
          </NButton>
        </div>
      </div>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading && !data" class="farm-card flex items-center justify-center gap-2 py-16 text-gray-400">
      <span class="i-svg-spinners-270-ring text-xl" />
      <span>正在加载排行榜…</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading && (!data || !data.list.length)" class="farm-card flex flex-col items-center justify-center gap-2 py-16 text-gray-400">
      <span class="i-carbon-trophy text-4xl" />
      <p class="text-sm">暂无排行榜数据，添加并启动农场账号后即可查看</p>
    </div>

    <template v-else>
      <!-- 前三名领奖台 -->
      <div v-if="podiumOrder.length" class="podium-grid">
        <div
          v-for="item in podiumOrder"
          :key="item.id"
          class="podium-card"
          :class="`podium-card--rank-${item.rank}`"
          :style="{ '--medal': medalOf(item.rank).color, '--medal-soft': medalOf(item.rank).soft, '--medal-chip': medalOf(item.rank).chip, '--medal-ink': medalOf(item.rank).ink }"
        >
          <div class="podium-card__glow" />
          <div class="relative z-1 flex flex-col items-center">
            <div class="podium-crown" :style="{ color: medalOf(item.rank).color }">
              <span :class="medalOf(item.rank).icon" />
            </div>
            <div class="podium-card__label" :style="{ color: medalOf(item.rank).color }">
              {{ medalOf(item.rank).label }}
            </div>
            <div class="podium-avatar">
              <img
                v-if="resolveAvatar(item)"
                :src="resolveAvatar(item)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="markAvatarFailed(item.id)"
              >
              <span v-else class="i-carbon-user-avatar text-3xl text-gray-300 dark:text-gray-600" />
              <span class="podium-rank-badge" :style="{ background: medalOf(item.rank).chip, color: medalOf(item.rank).ink }">
                {{ item.rank }}
              </span>
            </div>
            <div class="mt-3 max-w-full truncate text-sm text-gray-800 font-semibold dark:text-gray-100" :title="item.name">
              {{ item.name }}
            </div>
            <div v-if="item.nick && item.nick !== item.name" class="mt-0.5 max-w-full truncate text-xs text-gray-400 dark:text-gray-500" :title="item.nick">
              {{ item.nick }}
            </div>
            <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">今日增加</div>
            <div class="podium-gain" :style="{ color: medalOf(item.rank).color }">
              {{ formatGain(item.todayGoldEarned) }}
            </div>
            <div class="mt-1 flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
              <span class="i-carbon-currency-dollar" />
              当前 {{ formatNumber(item.gold) }}
            </div>
          </div>
        </div>
      </div>

      <!-- 第 4 名起列表 -->
      <div v-if="restList.length" class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
        <div class="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-700/40">
          <div class="flex items-center gap-2">
            <span class="i-carbon-list text-lg text-gray-500 dark:text-gray-400" />
            <h3 class="text-sm text-gray-700 font-semibold dark:text-gray-300">其他排名</h3>
            <span class="text-xs text-gray-400">第 4 名起</span>
          </div>
        </div>
        <div class="divide-y divide-gray-100 dark:divide-gray-700/60">
          <div
            v-for="item in restList"
            :key="item.id"
            class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/30 sm:px-5"
          >
            <div class="w-7 shrink-0 text-center text-sm text-gray-400 font-semibold tabular-nums dark:text-gray-500">
              {{ item.rank }}
            </div>
            <div class="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
              <img
                v-if="resolveAvatar(item)"
                :src="resolveAvatar(item)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="markAvatarFailed(item.id)"
              >
              <span v-else class="h-full w-full flex items-center justify-center i-carbon-user-avatar text-xl text-gray-300 dark:text-gray-500" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-100" :title="item.name">
                {{ item.name }}
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <span v-if="item.nick && item.nick !== item.name" class="truncate" :title="item.nick">{{ item.nick }}</span>
                <span v-if="item.running" class="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                  <span class="h-1.5 w-1.5 rounded-full bg-green-500" />运行中
                </span>
              </div>
            </div>
            <div class="shrink-0 text-right">
              <div class="text-sm text-amber-600 font-bold tabular-nums dark:text-amber-400">
                {{ formatGain(item.todayGoldEarned) }}
              </div>
              <div class="text-[11px] text-gray-400">今日增加</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.podium-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: 12px;
}

.podium-card {
  position: relative;
  overflow: hidden;
  min-width: 0;
  padding: 18px 12px 20px;
  border: 2px solid var(--medal);
  border-radius: 18px;
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm), 0 0 0 4px var(--medal-soft);
  text-align: center;
}

.podium-card__glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 80% at 50% 0%, var(--medal-soft), transparent 70%);
  pointer-events: none;
}

.podium-card--rank-1 {
  padding-top: 28px;
  padding-bottom: 28px;
  box-shadow: var(--ui-shadow-md), 0 0 0 5px var(--medal-soft);
}

.podium-crown {
  font-size: 28px;
  line-height: 1;
}

.podium-card--rank-1 .podium-crown {
  font-size: 34px;
}

.podium-card__label {
  margin-top: 4px;
  font-size: 13px;
  font-weight: var(--fw-700);
}

.podium-avatar {
  position: relative;
  width: 64px;
  height: 64px;
  margin: 12px auto 0;
  overflow: visible;
  border-radius: 9999px;
  background: var(--ui-bg-soft);
  display: flex;
  align-items: center;
  justify-content: center;
}

.podium-card--rank-1 .podium-avatar {
  width: 76px;
  height: 76px;
}

.podium-avatar img {
  border-radius: 9999px;
  border: 3px solid var(--medal);
}

.podium-rank-badge {
  position: absolute;
  right: -4px;
  bottom: -2px;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  border: 2px solid var(--ui-surface-solid);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: var(--fw-800);
}

.podium-gain {
  margin-top: 2px;
  font-size: 20px;
  font-weight: var(--fw-800);
  font-variant-numeric: tabular-nums;
}

.podium-card--rank-1 .podium-gain {
  font-size: 24px;
}

@media (max-width: 480px) {
  .podium-grid {
    gap: 8px;
  }

  .podium-card {
    padding: 14px 6px 16px;
    border-radius: 14px;
  }

  .podium-card--rank-1 {
    padding-top: 20px;
    padding-bottom: 20px;
  }

  .podium-crown {
    font-size: 22px;
  }

  .podium-card--rank-1 .podium-crown {
    font-size: 26px;
  }

  .podium-avatar {
    width: 48px;
    height: 48px;
  }

  .podium-card--rank-1 .podium-avatar {
    width: 58px;
    height: 58px;
  }

  .podium-gain {
    font-size: 15px;
  }

  .podium-card--rank-1 .podium-gain {
    font-size: 17px;
  }
}
</style>
