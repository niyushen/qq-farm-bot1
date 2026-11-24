<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AccountCareerModal from '@/components/AccountCareerModal.vue'
import LevelForecast from '@/components/LevelForecast.vue'
import RunLogPanel from '@/components/RunLogPanel.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { getPlatformLabel, useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const toastStore = useToastStore()
const {
  status,
  diamondBalance,
  realtimeConnected,
  currentAccountConnected,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
// 在线状态以实时状态为准：账号列表的 running 字段可能还是重启前的旧值
const isOnline = computed(() => currentAccountConnected.value)
const { dashboardItems } = storeToRefs(bagStore)
const lastBagFetchAt = ref(0)

const displayName = computed(() => {
  const account = accountStore.currentAccount

  // Try to use nickname from status (game server)
  const gameName = status.value?.status?.name
  if (gameName) {
    // 如果有备注，显示为“昵称（备注）”
    if (account?.name && account.name !== gameName) {
      return `${gameName} (${account.name})`
    }
    return gameName
  }

  // Check login status
  if (!status.value?.connection?.connected) {
    if (account) {
      // 如果有备注和昵称，显示为“昵称（备注）”
      if (account.name && account.nick && account.name !== account.nick) {
        return `${account.nick} (${account.name})`
      }
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }

  // Fallback to account name (usually ID) or '未命名'
  if (account) {
    // 如果有备注和昵称，显示为“昵称（备注）”
    if (account.name && account.nick && account.name !== account.nick) {
      return `${account.nick} (${account.name})`
    }
    return account.name || account.nick || '未命名'
  }
  return '未命名'
})

// Exp Rate & Time to Level
const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.sessionElapsedSeconds ?? status.value?.uptime ?? 0
  if (!uptime)
    return '0/时'
  const hours = uptime / 3600
  const rate = hours > 0 ? (gain / hours) : 0
  return `${Math.floor(rate)}/时`
})

// Fertilizer & Collection
const fertilizerNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3002))

function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  const count = Number(item.count || 0)
  return `${(count / 3600).toFixed(1)}h`
}

// Next Check Countdown
const nextFarmCheck = ref('--:--:--')
const nextFriendCheck = ref('--:--:--')
const nextHelpCheck = ref('--:--:--')
const nextStealCheck = ref('--:--:--')
const countdownNow = ref(Date.now())
/**
 * 「已运行」时长。
 *
 * 旧实现是一个 ref：每秒 `localUptime++`，同时每 10s 被整包 status 的
 * `uptime`（其实还是后端进程的 process.uptime）覆盖回去。两个来源来回
 * 覆盖，数字会忽进忽退，长度一变整行就换行错位，看起来就是「位置跳来跳去」。
 *
 * 现在改成「服务端锚点 + 本地时间差」的 computed：
 * - 单调递增，不会被覆盖回退；
 * - 每秒只按本地时钟算，不依赖推送节奏；
 * - 服务端值只作为锚点，且只接受明显推进的锚点，避免取整造成 ±1 抖动。
 */
const uptimeAnchorSec = ref(0)
const uptimeAnchorAt = ref(0)
const localUptime = computed(() => {
  if (!uptimeAnchorSec.value)
    return 0
  const drift = Math.max(0, (countdownNow.value - uptimeAnchorAt.value) / 1000)
  return Math.floor(uptimeAnchorSec.value + drift)
})
const farmCountdownTotal = ref(1)
const helpCountdownTotal = ref(1)
const stealCountdownTotal = ref(1)
let localNextFarmRemainSec = 0
let localNextFriendRemainSec = 0
let localNextHelpRemainSec = 0
let localNextStealRemainSec = 0
let farmQuiet = false
let friendQuiet = false
let helpEnabled = true
let stealEnabled = true

function syncCountdownTotal(total: typeof farmCountdownTotal, remain: number, previousRemain: number) {
  if (remain > previousRemain || total.value <= 1)
    total.value = Math.max(1, remain)
}

function getCountdownProgress(remain: number, total: number) {
  return Math.max(0, Math.min(100, (remain / Math.max(1, total)) * 100))
}

/** 环形进度：与桌面副本一致，用 conic-gradient 画圆环，外圈颜色按模块区分。 */
function getCountdownRingStyle(progress: number, color: string) {
  return {
    background: `conic-gradient(${color} ${progress}%, color-mix(in srgb, ${color} 14%, transparent) 0)`,
  }
}

function updateCountdowns() {
  // Update uptime
  countdownNow.value = Date.now()
  if (!status.value?.connection?.connected) {
    nextFarmCheck.value = '账号未登录'
    nextFriendCheck.value = '账号未登录'
    nextHelpCheck.value = '账号未登录'
    nextStealCheck.value = '账号未登录'
  }
  else {
    if (farmQuiet) {
      nextFarmCheck.value = '静默中'
    }
    else if (localNextFarmRemainSec > 0) {
      localNextFarmRemainSec--
      nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
    }
    else {
      nextFarmCheck.value = '巡查中...'
    }

    if (friendQuiet) {
      nextFriendCheck.value = '静默中'
    }
    else if (localNextFriendRemainSec > 0) {
      localNextFriendRemainSec--
      nextFriendCheck.value = formatDuration(localNextFriendRemainSec)
    }
    else {
      nextFriendCheck.value = '巡查中...'
    }

    // 帮助与偷菜各自独立：开关关闭时显示「已关闭」，不再显示读数。
    if (!helpEnabled) {
      nextHelpCheck.value = '已关闭'
    }
    else if (friendQuiet) {
      nextHelpCheck.value = '静默中'
    }
    else if (localNextHelpRemainSec > 0) {
      localNextHelpRemainSec--
      nextHelpCheck.value = formatDuration(localNextHelpRemainSec)
    }
    else {
      nextHelpCheck.value = '巡查中...'
    }

    if (!stealEnabled) {
      nextStealCheck.value = '已关闭'
    }
    else if (friendQuiet) {
      nextStealCheck.value = '静默中'
    }
    else if (localNextStealRemainSec > 0) {
      localNextStealRemainSec--
      nextStealCheck.value = formatDuration(localNextStealRemainSec)
    }
    else {
      nextStealCheck.value = '巡查中...'
    }
  }
}

watch(() => status.value?.nextChecks, (nextChecks) => {
  if (nextChecks) {
    // Only update local counters if they are significantly different or 0
    // Actually, we should sync from server periodically.
    // Here we just take server value when it comes.
    localNextFarmRemainSec = nextChecks.farmRemainSec || 0
    // 统一好友任务倒计时；兼容旧 Worker 返回的帮助/偷菜字段。
    localNextFriendRemainSec = nextChecks.friendRemainSec
      ?? nextChecks.helpRemainSec
      ?? nextChecks.stealRemainSec
      ?? 0
    // 帮助与偷菜各自独立计时：worker 各自下发，缺省时回落到统一的好友轮。
    localNextHelpRemainSec = nextChecks.helpRemainSec ?? localNextFriendRemainSec
    localNextStealRemainSec = nextChecks.stealRemainSec ?? localNextFriendRemainSec
    syncCountdownTotal(helpCountdownTotal, localNextHelpRemainSec, localNextHelpRemainSec)
    syncCountdownTotal(stealCountdownTotal, localNextStealRemainSec, localNextStealRemainSec)
    farmQuiet = !!nextChecks.farmQuiet
    friendQuiet = nextChecks.friendQuiet
      ?? nextChecks.helpQuiet
      ?? nextChecks.stealQuiet
      ?? false
    helpEnabled = nextChecks.helpEnabled !== false
    stealEnabled = nextChecks.stealEnabled !== false
    updateCountdowns() // Update immediately
  }
}, { immediate: true })

/**
 * 服务端只作为锚点：明显推进才接受，避免整包推送到来时间与每秒自增互相覆盖。
 *
 * 但账号重启（或掉线后换新 worker）时 uptime 会归零，那也必须跟着归零，
 * 否则「已运行」会一直卡着重启前的数字。用「回退幅度」区分两种情况：
 * 小幅回退（< 60s）是取整/网络延迟造成的抖动，忽略；大幅回退视为重启，重新锚定。
 */
watch(() => status.value?.uptime, (uptime) => {
  const next = Number(uptime)
  if (!Number.isFinite(next) || next <= 0)
    return
  const anchorAt = Date.now()
  const projected = uptimeAnchorSec.value
    ? uptimeAnchorSec.value + Math.max(0, (anchorAt - uptimeAnchorAt.value) / 1000)
    : 0
  const rolledBack = next + 60 < projected
  // 允许 0.5s 的浮点/取整误差；不属于重启的小幅回退直接忽略，保证数字单调。
  if (!rolledBack && next + 0.5 < projected)
    return
  uptimeAnchorSec.value = next
  uptimeAnchorAt.value = anchorAt
}, { immediate: true })

/** 切换账号时立刻清空，避免短暂显示上一个账号的运行时长。 */
watch(currentAccountId, () => {
  uptimeAnchorSec.value = 0
  uptimeAnchorAt.value = 0
})

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const pad = (n: number) => n.toString().padStart(2, '0')

  if (d > 0)
    return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

const OP_META: Record<string, { label: string, icon: string, color: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  farming: { label: '一键务农', icon: 'i-carbon-clean', color: 'text-teal-500' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpFarming: { label: '帮务农', icon: 'i-carbon-collaborate', color: 'text-yellow-400' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-pest', color: 'text-red-400' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-pest', color: 'text-red-300' },
  goldenBugClear: { label: '清黄金虫', icon: 'i-carbon-clean', color: 'text-amber-500' },
  goldenBugPut: { label: '放黄金虫', icon: 'i-carbon-pest', color: 'text-yellow-500' },
  tongQiGift: { label: '同气礼包', icon: 'i-carbon-gift', color: 'text-rose-500' },
}

const filteredOperations = computed(() => {
  const ops = status.value?.operations || {}
  const result: Record<string, number> = {}
  // 先按 OP_META 定义的固定顺序输出（与源码一致），再追加其余键
  for (const key of Object.keys(OP_META)) {
    if (key in ops) {
      result[key] = ops[key]
    }
  }
  for (const key of Object.keys(ops)) {
    if (!(key in result) && key !== 'upgrade' && key !== 'levelUp') {
      result[key] = ops[key]
    }
  }
  return result
})

const OPS_COLLAPSED_COUNT = 8

const showAllOperations = ref(false)

/**
 * 今日统计分区：有记录（>0）的动作按次数降序展示，无记录的收进折叠区。
 * 「展开全部」按钮默认只显示前 8 项，这里额外给出按活跃度排序的视图，
 * 让最常发生的动作始终排在前面（固定 OP_META 顺序会把低频动作顶到显眼位置）。
 */
const operationGroups = computed(() => {
  const entries = Object.entries(filteredOperations.value)
  return {
    active: entries.filter(([, value]) => Number(value) > 0).sort((a, b) => Number(b[1]) - Number(a[1])),
    inactive: entries.filter(([, value]) => !(Number(value) > 0)),
  }
})

/**
 * 动作网格的展示顺序：有记录的按次数降序在前，无记录的按 OP_META 固定顺序垫后。
 * 「展开全部」关闭时仍只截取前 8 项，避免一屏塞进几十个格子。
 */
const orderedOperations = computed(() => {
  const { active, inactive } = operationGroups.value
  return [...active, ...inactive]
})

const visibleOperations = computed(() => {
  const entries = orderedOperations.value
  if (showAllOperations.value || entries.length <= OPS_COLLAPSED_COUNT)
    return Object.fromEntries(entries)
  return Object.fromEntries(entries.slice(0, OPS_COLLAPSED_COUNT))
})

const hasMoreOperations = computed(() => orderedOperations.value.length > OPS_COLLAPSED_COUNT)

/** 今日四项增量：金币 / 经验 / 金豆 / 点券。 */
const todayGoldGained = computed(() => Number(status.value?.todayGoldGained ?? status.value?.sessionGoldGained ?? 0))
const todayExpGained = computed(() => Number(status.value?.todayExpGained ?? status.value?.sessionExpGained ?? 0))
const todayGoldBeanGained = computed(() => Number(status.value?.todayGoldBeanGained ?? status.value?.sessionGoldBeanGained ?? 0))
const todayCouponGained = computed(() => Number(status.value?.todayCouponGained ?? status.value?.sessionCouponGained ?? 0))

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}

function getOpIcon(key: string | number) {
  return OP_META[String(key)]?.icon
}

/**
 * 平台标签缓存：账号列表刷新失败的瞬间 currentAccount 会变 undefined，
 * 直接绑 computed 会让「微信 / QQ」这两个字短暂消失，后面元素跟着左移。
 */
const platformLabel = ref('')
watch(() => accountStore.currentAccount?.platform, (platform) => {
  const label = getPlatformLabel(platform)
  if (label)
    platformLabel.value = label
}, { immediate: true })

/** 与旧版一致：状态就绪且连接在线时才展示真实倒计时。 */
const checksReady = computed(() => !!status.value && !statusStore.error && status.value?.connection?.connected === true)

const syncLabel = computed(() => {
  if (!currentAccountId.value)
    return '未选择账号'
  if (statusStore.error)
    return '同步失败'
  if (!status.value)
    return '正在同步'
  if (!status.value?.connection?.connected)
    return '账号未连接'
  return realtimeConnected.value ? '实时同步中' : '轮询同步中'
})

interface DashboardCheck {
  key: string
  label: string
  icon: string
  time: string
  progress: number
  color: string
  description?: string
}

const countdowns = computed((): DashboardCheck[] => [
  {
    key: 'farm',
    label: '农场',
    icon: 'i-carbon-sprout',
    color: '#22c55e',
    time: nextFarmCheck.value,
    progress: getCountdownProgress(localNextFarmRemainSec, farmCountdownTotal.value),
  },
  {
    key: 'help',
    label: '帮助',
    icon: 'i-carbon-user-multiple',
    color: '#3b82f6',
    time: nextHelpCheck.value,
    progress: helpEnabled ? getCountdownProgress(localNextHelpRemainSec, helpCountdownTotal.value) : 0,
    description: helpEnabled ? '与偷菜同轮好友巡查' : '好友帮助已关闭',
  },
  {
    key: 'steal',
    label: '偷菜',
    icon: 'i-carbon-run',
    color: '#f97316',
    time: nextStealCheck.value,
    progress: stealEnabled ? getCountdownProgress(localNextStealRemainSec, stealCountdownTotal.value) : 0,
    description: stealEnabled ? '与帮助同轮好友巡查' : '好友偷菜已关闭',
  },
])

// —— 一键重连（仅微信账号）——
// 微信账号的登录凭据可再生：后端能用 loginBuffer/refreshtoken 换新 Code 并重启 Worker，
// 不需要用户重新扫码或手填 Code。失效原因分两类，界面必须区分：
//   - 授权被明确撤销（need_rescan）：只能重新扫码，直接引导到扫码弹窗
//   - 网络抖动/临时失败：稍后重试即可，留在原地让用户再点一次
const isWxAccount = computed(() => String(accountStore.currentAccount?.platform || '') === 'wx')
const reconnecting = ref(false)

async function handleReconnect() {
  const accountId = currentAccountId.value
  if (!accountId || reconnecting.value)
    return

  reconnecting.value = true
  try {
    const { data } = await api.post(`/api/accounts/${accountId}/reconnect`, {}, {
      timeout: 120000,
      skipErrorToast: true,
    } as any)

    if (data?.ok) {
      toastStore.success('重连成功，正在恢复挂机')
      // 重连会重启 Worker，等待状态回推后再刷新，避免读到旧的离线状态
      // （日志由 RunLogPanel 组件自行管理刷新，此处只需刷新状态与背包）
      await refresh()
      return
    }

    const reason = String(data?.reason || '')
    const message = getApiErrorMessage(data, '重连失败，请稍后重试')
    if (reason === 'need_rescan' || reason === 'no_credential') {
      toastStore.warning(message)
      // 授权已失效：交给侧边栏统一弹出扫码登录弹窗，避免两处弹窗互相遮挡
      accountStore.requestRelogin(accountId)
      return
    }
    toastStore.error(message)
  }
  catch (e: any) {
    toastStore.error(getApiErrorMessage(e, '重连失败，请稍后重试'))
  }
  finally {
    reconnecting.value = false
  }
}

const accountAvatar = computed(() => {
  const account = accountStore.currentAccount
  if (!account)
    return ''
  const live = String(status.value?.accountId || '') === String(account.id || '')
    ? String(status.value?.status?.avatarUrl || '').trim()
    : ''
  return live || String(account.avatar || '').trim()
})
const failedAccountAvatar = ref('')

watch(accountAvatar, () => {
  failedAccountAvatar.value = ''
})

function handleAccountAvatarError(event: Event) {
  failedAccountAvatar.value = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src') || ''
}

function formatPlainNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : '0'
}

// 今日金币收入：只计增加量、忽略升级等花费；兼容旧状态缺少该字段时回退净值
function todayGoldEarned() {
  const earned = status.value?.todayGoldEarned
  return earned === undefined || earned === null
    ? status.value?.todayGoldGained || 0
    : earned
}

function getExpPercent(p: any) {
  if (!p || !p.needed)
    return 0
  return Math.min(100, Math.max(0, (p.current / p.needed) * 100))
}

function formatAssetAmount(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-CN') : '0'
}

/**
 * 紧凑金额：上万显示「万」、上亿显示「亿」。
 * 金币与金豆豆动辄几十万，纯千分位会把卡片撑得很宽、把倒计时挤到下一行。
 */
function formatCompactAsset(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num))
    return '0'
  const abs = Math.abs(num)
  if (abs >= 100000000)
    return `${(num / 100000000).toFixed(2)}亿`
  if (abs >= 10000)
    return `${(num / 10000).toFixed(2)}万`
  return Math.trunc(num).toLocaleString('zh-CN')
}

async function refreshBag(force = false) {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return

  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 2500)
    return
  lastBagFetchAt.value = now
  await bagStore.fetchBag(currentAccountId.value)
}

async function refreshDiamond() {
  if (!currentAccountId.value || !currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return
  await statusStore.fetchDiamond(currentAccountId.value)
}

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    // 首次加载、断线兜底时走 HTTP；连接正常时优先走 WS 实时推送
    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    // 仅在账号已运行且连接就绪后拉背包，避免启动阶段触发500
    await refreshBag()
  }
}
// 个人页（角色生涯）：入口只在首页头像。
const showCareerModal = ref(false)
const careerLoading = ref(false)
const careerError = ref('')
const careerProfile = ref<Record<string, any>>({})
const careerItems = ref<any[]>([])

async function loadCareer() {
  if (!currentAccountId.value)
    return
  careerLoading.value = true
  careerError.value = ''
  try {
    const { data } = await api.get('/api/career')
    if (!data?.ok)
      throw new Error(getApiErrorMessage(data, '生涯记录读取失败'))
    careerProfile.value = data.data || {}
    careerItems.value = data.data?.items || []
  }
  catch (e: any) {
    careerError.value = getApiErrorMessage(e, '生涯记录读取失败')
  }
  finally {
    careerLoading.value = false
  }
}

function openCareer() {
  if (!currentAccountId.value)
    return
  showCareerModal.value = true
  void loadCareer()
}

watch(currentAccountId, async () => {
  diamondBalance.value = 0
  await refresh()
  await refreshDiamond()
  // 生涯弹窗打开时切换账号需要同步刷新对应账号的数据
  if (showCareerModal.value)
    void loadCareer()
})

watch(() => status.value?.connection?.connected, (connected) => {
  if (connected) {
    refreshBag(true)
    refreshDiamond()
  }
})

function operationsEqual(next: Record<string, unknown> | null | undefined, prev: Record<string, unknown> | null | undefined) {
  const nextOperations = next || {}
  const prevOperations = prev || {}
  const nextKeys = Object.keys(nextOperations)
  const prevKeys = Object.keys(prevOperations)
  return nextKeys.length === prevKeys.length && nextKeys.every(key => nextOperations[key] === prevOperations[key])
}

watch(() => status.value?.operations, (next, prev) => {
  if (!realtimeConnected.value || operationsEqual(next, prev))
    return
  refreshBag()
})

onMounted(async () => {
  await refresh()
  await refreshDiamond()
})

// Countdown timer (every 1s)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="page-stack flex flex-col gap-5">
    <!-- Overview -->
    <div class="overview-grid">
      <!-- 账号：身份、在线状态与等级进度 -->
      <section class="ov-card ov-account">
        <div class="ov-account__head">
          <button type="button" class="ov-avatar" :class="{ 'is-online': isOnline }" aria-label="查看角色生涯" title="查看角色生涯" @click="openCareer">
            <img v-if="accountAvatar && accountAvatar !== failedAccountAvatar" :key="accountAvatar" :src="accountAvatar" alt="" @error="handleAccountAvatarError">
            <span v-else class="i-carbon-user-avatar" />
            <i class="ov-avatar__dot" />
          </button>
          <div class="min-w-0 flex-1">
            <div class="ov-account__name-row">
              <strong class="ov-account__name" :title="displayName">{{ displayName }}</strong>
              <span class="ov-level">Lv.{{ status?.status?.level || 0 }}</span>
              <!-- 一键重连：微信凭据可再生，后端换新 Code 后自动重启 Worker，无需重新扫码 -->
              <BaseButton
                v-if="isWxAccount"
                variant="ghost"
                size="sm"
                class="ov-reconnect"
                :loading="reconnecting"
                title="一键重连：重新获取 Code 并重启账号"
                aria-label="一键重连"
                @click="handleReconnect"
              >
                <template #icon>
                  <span class="i-carbon-renew" />
                </template>
                <span class="ov-reconnect__label">一键重连</span>
              </BaseButton>
            </div>
            <div class="ov-presence">
              <span class="ov-presence__state" :class="isOnline ? 'is-online' : 'is-offline'">{{ isOnline ? '在线' : '离线' }}</span>
              <span v-if="isOnline" class="ov-presence__item"><span class="i-carbon-time" />已运行 {{ formatDuration(localUptime) }}</span>
              <span v-if="platformLabel" class="ov-presence__item">{{ platformLabel }}</span>
            </div>
          </div>
        </div>

        <div class="ov-exp">
          <div class="ov-exp__labels">
            <span>经验</span>
            <span class="ov-exp__value">
              {{ formatPlainNumber(status?.levelProgress?.current) }} / {{ status?.levelProgress?.needed ? formatPlainNumber(status.levelProgress.needed) : '?' }}
              <b>{{ Math.floor(getExpPercent(status?.levelProgress)) }}%</b>
            </span>
          </div>
          <div class="ov-exp__track">
            <div class="ov-exp__bar" :style="{ width: `${getExpPercent(status?.levelProgress)}%` }" />
          </div>
        </div>

        <div class="ov-account__foot">
          <span>本次经验/时 <b>{{ expRate }}</b></span>
          <LevelForecast v-if="isOnline" class="ov-forecast" :forecast="status?.levelForecast" />
        </div>
      </section>

      <!-- 资产 -->
      <section class="ov-card">
        <h3 class="ov-card__title">
          资产
        </h3>
        <div class="ov-tiles">
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-coins text-yellow-500" />金币</span>
            <strong class="ov-tile__value">{{ formatCompactAsset(status?.status?.gold) }}</strong>
            <small v-if="(status?.runGoldGained || 0) !== 0" class="ov-tile__delta" :class="(status?.runGoldGained || 0) > 0 ? 'is-up' : 'is-down'">
              本次 {{ (status?.runGoldGained || 0) > 0 ? '+' : '' }}{{ formatPlainNumber(status?.runGoldGained) }}
            </small>
            <small v-if="todayGoldEarned() !== 0" class="ov-tile__delta is-up">
              今日 +{{ formatPlainNumber(todayGoldEarned()) }}
            </small>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-ticket-alt text-emerald-500" />点券</span>
            <strong class="ov-tile__value">{{ formatCompactAsset(status?.status?.coupon) }}</strong>
            <small v-if="(status?.runCouponGained || 0) !== 0" class="ov-tile__delta" :class="(status?.runCouponGained || 0) > 0 ? 'is-up' : 'is-down'">
              本次 {{ (status?.runCouponGained || 0) > 0 ? '+' : '' }}{{ formatPlainNumber(status?.runCouponGained) }}
            </small>
            <small v-if="(status?.todayCouponGained || 0) !== 0" class="ov-tile__delta" :class="(status?.todayCouponGained || 0) > 0 ? 'is-up' : 'is-down'">
              今日 {{ (status?.todayCouponGained || 0) > 0 ? '+' : '' }}{{ formatPlainNumber(status?.todayCouponGained) }}
            </small>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-seedling text-amber-500" />金豆豆</span>
            <strong class="ov-tile__value">{{ formatCompactAsset(status?.status?.goldBean) }}</strong>
            <small v-if="(status?.sessionGoldBeanGained || 0) !== 0" class="ov-tile__delta" :class="(status?.sessionGoldBeanGained || 0) > 0 ? 'is-up' : 'is-down'">
              本次 {{ (status?.sessionGoldBeanGained || 0) > 0 ? '+' : '' }}{{ formatPlainNumber(status?.sessionGoldBeanGained) }}
            </small>
            <small v-if="(status?.todayGoldBeanGained || 0) !== 0" class="ov-tile__delta" :class="(status?.todayGoldBeanGained || 0) > 0 ? 'is-up' : 'is-down'">
              今日 {{ (status?.todayGoldBeanGained || 0) > 0 ? '+' : '' }}{{ formatPlainNumber(status?.todayGoldBeanGained) }}
            </small>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-gem text-cyan-500" />钻石</span>
            <strong class="ov-tile__value">{{ formatAssetAmount(diamondBalance) }}</strong>
          </div>
        </div>
      </section>

      <!-- 库存：化肥容器与收藏点 -->
      <section class="ov-card">
        <h3 class="ov-card__title">
          库存
        </h3>
        <div class="ov-tiles">
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-flask text-emerald-500" />普通化肥</span>
            <strong class="ov-tile__value">{{ formatBucketTime(fertilizerNormal) }}</strong>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-vial text-emerald-500" />有机化肥</span>
            <strong class="ov-tile__value">{{ formatBucketTime(fertilizerOrganic) }}</strong>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-bookmark text-violet-400" />普通收藏点</span>
            <strong class="ov-tile__value">{{ formatPlainNumber(collectionNormal?.count) }}</strong>
          </div>
          <div class="ov-tile">
            <span class="ov-tile__label"><span class="i-fas-gem text-violet-400" />典藏收藏点</span>
            <strong class="ov-tile__value">{{ formatPlainNumber(collectionRare?.count) }}</strong>
          </div>
        </div>
      </section>
    </div>

    <!-- Main Content Flex -->
    <div class="flex flex-1 flex-col items-stretch gap-6 md:flex-row">
      <!-- Logs (Left Column) -->
      <div class="order-2 flex flex-1 flex-col gap-6 md:order-1 md:w-3/4">
        <!-- Logs -->
        <div class="flex flex-1 flex-col farm-card rounded-2xl bg-white p-5 shadow-md md:overflow-hidden dark:bg-gray-800">
          <RunLogPanel default-module="farm" :max-logs="200" list-class="max-h-[50vh] min-h-0 flex-1" />
        </div>
      </div>

      <!-- Right Column Stack -->
      <div class="order-1 min-w-0 flex flex-col gap-6 md:order-2 md:w-1/4 md:self-start">
        <!-- Next Checks -->
        <div class="flex flex-col farm-card rounded-2xl bg-white p-5 shadow-md dark:bg-gray-800">
          <h3 class="mb-3 flex items-center justify-between gap-2 text-lg font-display font-medium">
            <span class="flex items-center gap-2"><span class="i-carbon-hourglass" /> <span>下次检查倒计时</span></span>
            <span class="dashboard-sync" :class="{ 'is-online': checksReady }">
              <span class="dashboard-sync-dot" />{{ syncLabel }}
            </span>
          </h3>
          <div class="grid grid-cols-3 gap-2">
            <div
              v-for="check in countdowns"
              :key="check.key"
              class="min-w-0 flex flex-col items-center text-center"
            >
              <div
                class="h-18 w-18 flex items-center justify-center rounded-full p-1"
                :style="getCountdownRingStyle(check.progress, check.color)"
              >
                <div class="h-full w-full flex flex-col items-center justify-center rounded-full bg-white dark:bg-gray-800">
                  <span :class="check.icon" class="text-xl" :style="{ color: check.color }" aria-hidden="true" />
                  <span class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ check.label }}</span>
                </div>
              </div>
              <div class="mt-1.5 w-full truncate text-sm font-mono font-bold 2xl:text-base" :title="checksReady ? check.time : syncLabel">
                {{ checksReady ? check.time : '—' }}
              </div>
            </div>
          </div>
        </div>

        <!-- Operations Grid -->
        <div class="farm-card rounded-2xl bg-white p-5 shadow-md dark:bg-gray-800">
          <h3 class="mb-3 flex items-center justify-between gap-2 text-lg font-display font-medium">
            <span class="flex items-center gap-2">
              <span class="i-carbon-chart-column" /> <span>今日统计</span>
            </span>
            <button
              v-if="hasMoreOperations"
              class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/40"
              @click="showAllOperations = !showAllOperations"
            >
              {{ showAllOperations ? '收起' : '展开全部' }}
              <span class="text-sm" :class="showAllOperations ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down'" />
            </button>
          </h3>
          <EmptyState
            v-if="!status?.connection?.connected"
            bare
            title="账号未登录"
            description="启动账号后显示今日收获与互动统计"
            icon="i-carbon-connection-signal-off"
          />
          <div v-else>
            <div class="grid grid-cols-2 mb-2 gap-2 2xl:gap-3" role="region" aria-label="今日金币、经验、金豆与点券增量">
              <div class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30">
                <div class="flex items-center gap-2">
                  <img src="/game-config/resource-icons/gold.png" alt="金币" class="h-5 w-5 object-contain 2xl:h-6 2xl:w-6" aria-hidden="true">
                  <div class="text-xs text-gray-500 2xl:text-sm">
                    金币
                  </div>
                </div>
                <div class="ov-today-value text-sm font-bold 2xl:text-base" :class="{ 'is-down': todayGoldGained < 0 }">
                  {{ todayGoldGained }}
                </div>
              </div>
              <div class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30">
                <div class="flex items-center gap-2">
                  <span class="i-carbon-star-filled text-base text-sky-500 2xl:text-lg" aria-hidden="true" />
                  <div class="text-xs text-gray-500 2xl:text-sm">
                    经验
                  </div>
                </div>
                <div class="text-sm font-bold 2xl:text-base">
                  {{ todayExpGained }}
                </div>
              </div>
              <div class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30">
                <div class="flex items-center gap-2">
                  <img src="/game-config/resource-icons/gold-bean.png" alt="金豆" class="h-5 w-5 object-contain 2xl:h-6 2xl:w-6" aria-hidden="true">
                  <div class="text-xs text-gray-500 2xl:text-sm">
                    金豆
                  </div>
                </div>
                <div class="ov-today-value text-sm font-bold 2xl:text-base" :class="{ 'is-down': todayGoldBeanGained < 0 }">
                  {{ todayGoldBeanGained }}
                </div>
              </div>
              <div class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30">
                <div class="flex items-center gap-2">
                  <img src="/game-config/resource-icons/coupon.png" alt="点券" class="h-5 w-5 object-contain 2xl:h-6 2xl:w-6" aria-hidden="true">
                  <div class="text-xs text-gray-500 2xl:text-sm">
                    点券
                  </div>
                </div>
                <div class="ov-today-value text-sm font-bold 2xl:text-base" :class="{ 'is-down': todayCouponGained < 0 }">
                  {{ todayCouponGained }}
                </div>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2 2xl:gap-3">
              <div
                v-for="(val, key) in visibleOperations"
                :key="key"
                class="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 transition-transform hover:scale-105 dark:bg-gray-700/30"
              >
                <div class="flex items-center gap-2">
                  <span class="select-none text-base 2xl:text-lg" :class="getOpIcon(key)" />
                  <div class="text-xs text-gray-500 2xl:text-sm">
                    {{ getOpName(key) }}
                  </div>
                </div>
                <div class="text-sm font-bold 2xl:text-base">
                  {{ val }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <AccountCareerModal
      :show="showCareerModal"
      :account="currentAccount"
      :profile="careerProfile"
      :items="careerItems"
      :loading="careerLoading"
      :error="careerError"
      @close="showCareerModal = false"
      @refresh="loadCareer"
    />
  </Teleport>
</template>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

@media (min-width: 768px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ov-account {
    grid-column: 1 / -1;
  }
}

@media (min-width: 1280px) {
  .overview-grid {
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr);
  }

  .ov-account {
    grid-column: auto;
  }
}

.ov-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.ov-card__title {
  margin: 0;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: var(--fw-600);
  line-height: 1.4;
}

/* 账号 */
.ov-account__head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.ov-avatar {
  position: relative;
  width: 52px;
  height: 52px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 16px;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
  font-size: 26px;
}

.ov-avatar img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.ov-avatar__dot {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 14px;
  height: 14px;
  border: 3px solid var(--ui-surface-strong);
  border-radius: 999px;
  background: var(--ui-subtle);
}

.ov-avatar.is-online .ov-avatar__dot {
  background: #3fa765;
}

.ov-account__name-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ov-account__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-level {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ui-blue);
  background: var(--ui-blue-soft);
  font-size: 12px;
  font-weight: var(--fw-700);
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}

/* 一键重连按钮：任何屏宽下均完整显示图标与文案 */
.ov-reconnect {
  flex: none;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.ov-reconnect :deep(.n-button__content) {
  gap: 4px;
}

.ov-reconnect__label {
  flex: none;
  white-space: nowrap;
}

@media (max-width: 420px) {
  .ov-reconnect {
    padding: 0 7px;
  }
}

.ov-presence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-top: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-presence__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 9px 1px 7px;
  border-radius: 999px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.ov-presence__state::before {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  content: '';
}

.ov-presence__state.is-online {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.ov-presence__state.is-offline {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.ov-presence__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.ov-exp__labels {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-exp__value {
  font-variant-numeric: tabular-nums;
}

.ov-exp__value b {
  margin-left: 6px;
  color: var(--ui-ink);
  font-weight: var(--fw-700);
}

.ov-exp__track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.ov-exp__bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #5c9fd0, #4b86c5);
  transition: width 0.5s ease;
}

.ov-account__foot {
  display: grid;
  gap: 4px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px dashed var(--ui-border-strong);
  color: var(--ui-muted);
  font-size: 12px;
}

.ov-account__foot b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
  font-variant-numeric: tabular-nums;
}

.ov-forecast {
  margin-top: 0 !important;
}

/* 资产 / 库存数据格 */
.ov-tiles {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.ov-tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.ov-tile__label {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}

.ov-tile__label > span {
  flex: none;
  font-size: 13px;
}

.ov-tile__value {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 20px;
  font-weight: var(--fw-700);
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov-tile__delta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ov-tile__delta.is-up {
  color: var(--ui-primary);
}

.ov-tile__delta.is-down {
  color: var(--ui-danger);
}

@media (max-width: 520px) {
  .ov-card {
    padding: 16px;
  }

  .ov-tile {
    padding: 10px 12px;
  }

  .ov-tile__value {
    font-size: clamp(15px, 4.5vw, 18px);
  }
}
</style>
