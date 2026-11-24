<script setup lang="ts">
import type { ReleasesSummary, RollbackReleaseItem } from '@/components/settings/ReleaseRollbackPanel.vue'
import type { Redemption } from '@/stores/user'
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { getApiErrorMessage } from '@/api'
import InviteCard from '@/components/account/InviteCard.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import AccountFeatureSettings from '@/components/settings/AccountFeatureSettings.vue'
import AccountManagementPanel from '@/components/settings/AccountManagementPanel.vue'
import FriendApplyTab from '@/components/settings/FriendApplyTab.vue'
import OfflineReminderCard from '@/components/settings/OfflineReminderCard.vue'
import ReleaseRollbackPanel from '@/components/settings/ReleaseRollbackPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useAccountStore } from '@/stores/account'
import { useAppUpdateStore } from '@/stores/app-update'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatExpiresAt, formatRemaining, useUserStore } from '@/stores/user'
import { parseHourOfDay } from '@/utils/hour-of-day'
import AdminPanel from '@/views/AdminPanel.vue'

const fertilizerLandTypeOptions = [
  { label: '蓝晶土地', value: 'blue-crystal' },
  { label: '紫金土地', value: 'purple-gold' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

const router = useRouter()
const route = useRoute()
const inRanch = computed(() => route.meta.gameSpace === 'ranch')
const accountStore = useAccountStore()
const userStore = useUserStore()
const settingStore = useSettingStore()
const statusStore = useStatusStore()
const appUpdateStore = useAppUpdateStore()
const toast = useToastStore()

type SettingsTab = 'account' | 'friend-apply' | 'farm-config' | 'ranch-config' | 'activity-config' | 'notification' | 'system-settings' | 'system' | 'my-account' | 'admin-panel'
const settingsTabKeys: SettingsTab[] = ['account', 'friend-apply', 'farm-config', 'ranch-config', 'activity-config', 'notification', 'system-settings', 'system', 'my-account', 'admin-panel']
// 牧场空间下只显示账号与系统（自动化/策略在独立「牧场策略」页）。
const ranchTabKeys: SettingsTab[] = ['account', 'system']
// 旧标签仍可能出现在收藏夹或外部链接里，统一折到新分类上。
const LEGACY_TAB_ALIAS: Record<string, SettingsTab> = {
  'strategy': 'farm-config',
  'automation': 'farm-config',
  'default-plan': 'farm-config',
  'account-config': 'farm-config',
  'user': 'my-account',
  'my-account': 'my-account',
  'admin': 'admin-panel',
  'capture': 'system',
}
function normalizeTab(value: string): SettingsTab | null {
  if (LEGACY_TAB_ALIAS[value])
    return LEGACY_TAB_ALIAS[value]
  return settingsTabKeys.includes(value as SettingsTab) ? value as SettingsTab : null
}
const storedTab = localStorage.getItem('settings-active-tab') || ''
const queryTab = String(route.query.tab || '')
const initialTabRaw = normalizeTab(queryTab) || normalizeTab(storedTab) || 'account'
// 管理后台仅超级管理员可见；牧场空间只保留账号与系统。
const initialTabBase = initialTabRaw === 'admin-panel' && !userStore.isSuperAdmin ? 'account' as SettingsTab : initialTabRaw
const initialTab = inRanch.value && !ranchTabKeys.includes(initialTabBase) ? 'account' as SettingsTab : initialTabBase
const activeTab = ref<SettingsTab>(initialTab)
const tabsNav = ref<HTMLElement | null>(null)

watch(activeTab, (newTab) => {
  localStorage.setItem('settings-active-tab', newTab)
  if (String(route.query.tab || '') !== newTab) {
    router.replace({
      query: { ...route.query, tab: newTab },
    })
  }
  void scrollActiveTabIntoView()
})

watch(() => route.query.tab, (value) => {
  const nextTab = normalizeTab(String(value || ''))
  if (!nextTab || nextTab === activeTab.value)
    return
  if (inRanch.value && !ranchTabKeys.includes(nextTab))
    return
  if (nextTab === 'admin-panel' && !userStore.isSuperAdmin)
    return
  activeTab.value = nextTab
})

const tabs = [
  { key: 'account', label: '账号管理', icon: 'i-carbon-user-settings' },
  { key: 'friend-apply', label: '好友申请', icon: 'i-carbon-user-favorite' },
  { key: 'farm-config', label: '农场设置', icon: 'i-carbon-sprout' },
  { key: 'ranch-config', label: '牧场设置', icon: 'i-fas-paw' },
  { key: 'activity-config', label: '活动设置', icon: 'i-carbon-events' },
  { key: 'notification', label: '通知设置', icon: 'i-carbon-notification' },
  { key: 'system-settings', label: '全局设置', icon: 'i-carbon-settings' },
  { key: 'system', label: '连接与设备', icon: 'i-carbon-settings-services' },
  { key: 'my-account', label: '我的账号', icon: 'i-carbon-user-avatar' },
  { key: 'admin-panel', label: '管理后台', icon: 'i-carbon-user-admin' },
] as const

const visibleTabs = computed(() =>
  tabs.filter(tab =>
    (!inRanch.value || ranchTabKeys.includes(tab.key as SettingsTab))
    && (tab.key !== 'admin-panel' || userStore.isSuperAdmin),
  ),
)

function setActiveTab(value: string) {
  if (settingsTabKeys.includes(value as SettingsTab))
    activeTab.value = value as SettingsTab
}

async function scrollActiveTabIntoView() {
  await nextTick()
  const button = tabsNav.value?.querySelector<HTMLElement>(`[data-settings-tab="${activeTab.value}"]`)
  button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
}

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

// ==================== 账号管理 ====================
const { accounts, currentAccountId } = storeToRefs(accountStore)

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})

function openAccountSettings(account: any) {
  if (account?.id)
    accountStore.selectAccount(String(account.id))
  activeTab.value = 'farm-config'
}

// ==================== 我的账号（订阅 / 卡密 / 邀请，当前 fork 独有） ====================
const cardCode = ref('')
const cardSubmitting = ref(false)
const myRedemptions = ref<Redemption[]>([])
const redemptionsLoading = ref(false)

// —— 微信定时刷新重登（按账号，当前 fork 独有）——
const localAutoCodeRefresh = ref({ enabled: false, intervalMinutes: 60 })
const autoCodeSaving = ref(false)
const autoCodeRefreshing = ref(false)
const currentAccount = computed(() => (accounts.value as any[]).find(acc => String(acc.id) === String(currentAccountId.value)) || null)
const currentAccountIsWx = computed(() => String(currentAccount.value?.platform || '') === 'wx')
const currentAccountHasCredential = computed(() => !!String(currentAccount.value?.loginBuffer || '').trim())

async function handleSaveAutoCodeRefresh() {
  if (!currentAccountId.value) {
    showAlert('请先选择账号', 'danger')
    return
  }
  const interval = Math.max(1, Math.min(1440, Number(localAutoCodeRefresh.value.intervalMinutes) || 60))
  localAutoCodeRefresh.value.intervalMinutes = interval
  autoCodeSaving.value = true
  try {
    const { data } = await api.post('/api/settings/auto-code-refresh', {
      enabled: localAutoCodeRefresh.value.enabled,
      intervalMinutes: interval,
    }, { headers: { 'x-account-id': currentAccountId.value } })
    if (data?.ok) {
      settingStore.settings.autoCodeRefresh = { ...localAutoCodeRefresh.value }
      showAlert('微信定时刷新设置已保存', 'primary')
    }
    else {
      showAlert(getApiErrorMessage({ response: { data } }, '保存失败'), 'danger')
    }
  }
  catch (error) {
    showAlert(getApiErrorMessage(error, '保存失败'), 'danger')
  }
  finally {
    autoCodeSaving.value = false
  }
}

async function handleRefreshCodeNow() {
  if (!currentAccountId.value)
    return
  autoCodeRefreshing.value = true
  try {
    const { data } = await api.post('/api/settings/auto-code-refresh/refresh', {}, {
      headers: { 'x-account-id': currentAccountId.value },
      timeout: 120000,
    })
    if (data?.ok)
      showAlert('刷新 Code 成功，账号已重启', 'primary')
    else
      showAlert(getApiErrorMessage({ response: { data } }, '刷新失败，请检查网络或重新扫码登录'), 'danger')
  }
  catch (error) {
    showAlert(getApiErrorMessage(error, '刷新失败，请检查网络或重新扫码登录'), 'danger')
  }
  finally {
    autoCodeRefreshing.value = false
  }
}

const myUsername = computed(() => String(userStore.username || '').trim())
const myAccounts = computed(() => {
  if (!myUsername.value)
    return [] as any[]
  return (accounts.value as any[]).filter(acc => String(acc?.owner || acc?.username || '').trim() === myUsername.value)
})
const myUnlimited = computed(() => userStore.accountLimit < 0)
const myAccountUsed = computed(() => myAccounts.value.length)
const myAccountRemaining = computed(() => myUnlimited.value ? -1 : Math.max(0, userStore.accountLimit - myAccountUsed.value))
const myRemainingText = computed(() => formatRemaining(
  userStore.subscription?.isPermanent
    ? null
    : userStore.subscription?.expiresAt ? userStore.subscription.expiresAt - Date.now() : 0,
))

async function loadMyRedemptions() {
  redemptionsLoading.value = true
  try {
    const result = await userStore.fetchMyRedemptions(30)
    myRedemptions.value = result.redemptions || []
  }
  catch {
    myRedemptions.value = []
  }
  finally {
    redemptionsLoading.value = false
  }
}

async function handleRenewCard() {
  const code = cardCode.value.trim()
  if (!code) {
    showAlert('请输入卡密', 'danger')
    return
  }
  cardSubmitting.value = true
  try {
    const result = await userStore.renew(code)
    if (!result.ok) {
      showAlert(result.error || '核销失败', 'danger')
      return
    }
    showAlert(`核销成功：${result.data?.summary || '已生效'}`, 'primary')
    cardCode.value = ''
    await userStore.fetchUserInfo()
    await loadMyRedemptions()
  }
  finally {
    cardSubmitting.value = false
  }
}

function configMyAccount(acc: any) {
  accountStore.selectAccount(String(acc.id))
}

onMounted(async () => {
  await accountStore.fetchAccounts()
  if (!currentAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
    accountStore.selectAccount(String(accounts.value[0].id))
  }
  if (currentAccountId.value)
    await loadStrategyData(currentAccountId.value)
  // 未选择账号时也要能加载自己的下线提醒配置（通知设置页）
  if (!currentAccountId.value)
    await settingStore.fetchUserSettings()
  await Promise.all([loadSystemConfig(), loadDevicePresets(), loadUpdateStatus()])
  await scrollActiveTabIntoView()
})

// 我的账号（兑换码/订阅/邀请）与全局邮件服务状态，进页面即刷新。
onMounted(loadMyRedemptions)
onMounted(() => {
  void settingStore.fetchGlobalMailer()
})

// ==================== 账号设置（策略 + 功能模块） ====================
const { settings, loading: settingsLoading, loadedAccountId } = storeToRefs(settingStore)
const automationSaving = ref(false)

// 微信定时刷新重登：本地状态跟随当前账号的设置（须在 settings 声明之后注册）
watch(() => [settings.value.autoCodeRefresh, currentAccountId.value] as const, ([cfg]) => {
  localAutoCodeRefresh.value = {
    enabled: cfg?.enabled === true,
    intervalMinutes: Number(cfg?.intervalMinutes) || 60,
  }
}, { immediate: true })

const localStrategySettings = ref({
  plantingStrategy: 'max_exp',
  preferredSeedId: 0,
  bagSeedPriority: [] as number[],
  bagSeedMultiLandReservationEnabled: false,
  bagSeedLandTypes: {} as Record<string, string[]>,
  bagSeedFallbackStrategy: 'level',
  prioritize2x2Crops: true,
  stealDelaySeconds: 0,
  plantOrderRandom: false,
  plantDelaySeconds: 0,
  intervals: { farmMin: 20, farmMax: 25, friendMin: 30, friendMax: 35 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
})

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '背包种子优先', value: 'bag_priority' },
]

const BAG_FALLBACK_STRATEGY_OPTIONS = [
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '优先种植种子', value: 'preferred' },
]

function syncLocalStrategySettings() {
  if (settings.value) {
    localStrategySettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      bagSeedPriority: settings.value.bagSeedPriority ?? [],
      bagSeedMultiLandReservationEnabled: !!settings.value.bagSeedMultiLandReservationEnabled,
      bagSeedLandTypes: settings.value.bagSeedLandTypes ?? {},
      bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
      prioritize2x2Crops: !!settings.value.prioritize2x2Crops,
      stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
      plantOrderRandom: !!settings.value.plantOrderRandom,
      plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
      intervals: settings.value.intervals,
      friendQuietHours: {
        enabled: false,
        start: '23:00',
        end: '07:00',
        continueFarm: true,
        ...(settings.value.friendQuietHours || {}),
      },
    }))
  }
}

async function loadStrategyData(accountId = currentAccountId.value) {
  if (!accountId)
    return
  const loaded = await settingStore.fetchSettings(accountId)
  if (!loaded || accountId !== currentAccountId.value)
    return
  syncLocalStrategySettings()
  syncLocalAutomationSettings()
  syncLocalOfflineSettings()
}

watch(currentAccountId, (accountId) => {
  automationSaving.value = false
  if (accountId)
    loadStrategyData(accountId)
})

// ==================== 自动控制 ====================
const allFertilizerLandTypes = ['blue-crystal', 'purple-gold', 'gold', 'black', 'red', 'normal']
const defaultFertilizerLandTypes = allFertilizerLandTypes.filter(type => type !== 'blue-crystal')

function normalizeFertilizerLandTypes(input: unknown) {
  const source = Array.isArray(input) ? input : defaultFertilizerLandTypes
  const normalized: string[] = []
  for (const item of source) {
    const value = String(item || '').trim().toLowerCase()
    if (!allFertilizerLandTypes.includes(value))
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

const localAutomationSettings = ref({
  automation: {
    farm: false,
    farm_harvest_tiangong: true,
    task: false,
    sell: true,
    friend: false,
    friend_auto_accept: true,
    farm_push: false,
    land_upgrade: true,
    friend_steal: false,
    friend_help: false,
    friend_bad: true,
    friend_help_exp_limit: false,
    friend_help_protect_dog_ignore_exp_limit: true,
    fertilizer_gift: false,
    fertilizer_buy_organic: false,
    fertilizer_buy_normal: false,
    mystery_shop_auto_buy: false,
    mystery_shop_allow_gold: true,
    mystery_shop_allow_coupon: false,
    mystery_shop_allow_gold_bean: false,
    mystery_shop_allow_diamond: false,
    mystery_shop_arrival_notify: false,
    mystery_shop_purchase_notify: false,
    fertilizer: 'normal',
    skip_own_weed_bug: false,
    fertilizer_multi_season: false,
    fertilizer_land_types: [...defaultFertilizerLandTypes],
    fertilizer_smart_seconds: 300,
    show_manual_fertilizer: true,
    pet_feed_dog_food: true,
    pet_feed_dog_food_auto_buy: true,
  },
  fertilizerBuyOrganicCount: 10,
  fertilizerBuyOrganicThresholdHours: 10,
  fertilizerBuyNormalCount: 10,
  fertilizerBuyNormalThresholdHours: 10,
  fertilizerBuyCheckIntervalMinutes: 30,
  emailClaimHour: 10 as number | string,
  goldenBugKeepCount: 0,
  goldenBugRoundLimit: 24,
  autoAcceptFriendMinLevel: 0,
  autoAcceptRequireOwnLevel: false,
  autoAcceptHarvestStealEnabled: true,
  autoAcceptHarvestStealHarvest: 8,
  autoAcceptHarvestStealSteal: 1,
})

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '普通 + 快成熟有机', value: 'smart' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '仅普通化肥催熟', value: 'normal_ripen' },
  { label: '仅有机化肥催熟', value: 'organic_ripen' },
  { label: '不施肥', value: 'none' },
]

function syncLocalAutomationSettings() {
  if (settings.value) {
    if (!settings.value.automation) {
      localAutomationSettings.value.automation = {
        farm: false,
        farm_harvest_tiangong: true,
        task: false,
        sell: false,
        friend: false,
        friend_auto_accept: true,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        friend_help_protect_dog_ignore_exp_limit: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
        show_manual_fertilizer: true,
        pet_feed_dog_food: true,
        pet_feed_dog_food_auto_buy: true,
      }
    }
    else {
      const defaults = {
        farm: false,
        farm_harvest_tiangong: true,
        task: false,
        sell: false,
        friend: false,
        friend_auto_accept: true,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        friend_help_protect_dog_ignore_exp_limit: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop_auto_buy: false,
        mystery_shop_allow_gold: true,
        mystery_shop_allow_coupon: false,
        mystery_shop_allow_gold_bean: false,
        mystery_shop_allow_diamond: false,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
        show_manual_fertilizer: true,
        pet_feed_dog_food: true,
        pet_feed_dog_food_auto_buy: true,
      }
      localAutomationSettings.value.automation = {
        ...defaults,
        ...settings.value.automation,
      }
    }
    localAutomationSettings.value.automation.fertilizer_land_types = normalizeFertilizerLandTypes(localAutomationSettings.value.automation.fertilizer_land_types)
    if (localAutomationSettings.value.automation.fertilizer_smart_seconds === undefined) {
      localAutomationSettings.value.automation.fertilizer_smart_seconds = 300
    }
    if (localAutomationSettings.value.automation.show_manual_fertilizer === undefined) {
      localAutomationSettings.value.automation.show_manual_fertilizer = true
    }
    localAutomationSettings.value.fertilizerBuyOrganicCount = settings.value.fertilizerBuyOrganicCount ?? 10
    localAutomationSettings.value.fertilizerBuyOrganicThresholdHours = settings.value.fertilizerBuyOrganicThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyNormalCount = settings.value.fertilizerBuyNormalCount ?? 10
    localAutomationSettings.value.fertilizerBuyNormalThresholdHours = settings.value.fertilizerBuyNormalThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes = settings.value.fertilizerBuyCheckIntervalMinutes ?? 30
    localAutomationSettings.value.emailClaimHour = settings.value.emailClaimHour ?? 10
    localAutomationSettings.value.goldenBugKeepCount = settings.value.goldenBugKeepCount ?? 0
    localAutomationSettings.value.goldenBugRoundLimit = settings.value.goldenBugRoundLimit ?? 24
    localAutomationSettings.value.autoAcceptFriendMinLevel = settings.value.autoAcceptFriendMinLevel ?? 0
    localAutomationSettings.value.autoAcceptRequireOwnLevel = settings.value.autoAcceptRequireOwnLevel ?? false
    localAutomationSettings.value.autoAcceptHarvestStealEnabled = settings.value.autoAcceptHarvestStealEnabled ?? true
    localAutomationSettings.value.autoAcceptHarvestStealHarvest = settings.value.autoAcceptHarvestStealHarvest ?? 8
    localAutomationSettings.value.autoAcceptHarvestStealSteal = settings.value.autoAcceptHarvestStealSteal ?? 1
  }
}

// ==================== 功能模块（旧版六模块） ====================
// 功能模块里既改 automation，也改部分策略字段（策略、巡查间隔、静默时段），
// 所以保存时把两份模型合并成一次请求，避免用户切换标签后改动丢失。
async function handleFeatureModuleSave(_module?: string, quiet?: boolean): Promise<boolean> {
  const accountId = currentAccountId.value
  if (!accountId)
    return false
  // 邮箱时刻只收 0–23 的整点：输入框会保留非法草稿（清空后是空串），
  // 后端 assertEmailClaimHour 对这份快照是硬校验，抛错会让整批设置一起不生效，
  // 所以显式保存必须在本地拦住，别发出去。
  const emailClaimHour = parseHourOfDay(localAutomationSettings.value.emailClaimHour)
  if (emailClaimHour === null && !quiet) {
    showAlert('「自动邮箱领取」时间需填写 0–23 的整数（时），改好后请再点一次保存。', 'danger')
    return false
  }
  automationSaving.value = true
  try {
    const payload: any = {
      ...JSON.parse(JSON.stringify(localStrategySettings.value)),
      ...JSON.parse(JSON.stringify(localAutomationSettings.value)),
    }
    // 归一成数字再发；合法草稿可能是字符串 '10'。
    payload.emailClaimHour = emailClaimHour
    if (payload.automation?.fertilizer_land_types) {
      payload.automation.fertilizer_land_types = normalizeFertilizerLandTypes(payload.automation.fertilizer_land_types)
    }
    if (payload.plantingStrategy === 'bag_priority') {
      // 顺序由弹窗里的背包排序组件维护，这里只做去重与非法值收敛，不再重排。
      payload.bagSeedPriority = [...new Set<number>((payload.bagSeedPriority || [])
        .map(Number)
        .filter((id: number) => Number.isFinite(id) && id > 0))]
    }
    // quiet（拨卡片开关）时非法草稿不应把整批开关堵死：这里置成 null，
    // store 的兜底会就地剔除这一个字段，其余设置照常保存，成功后回填会顺手修正草稿。
    const res = await settingStore.saveSettings(accountId, payload)
    if (accountId !== currentAccountId.value)
      return false
    if (res.ok) {
      syncLocalStrategySettings()
      syncLocalAutomationSettings()
      // 卡片开关的 emit('save', key, true) 是静默保存，不该每次拨动都弹模态框。
      if (!quiet)
        showAlert('功能模块设置已保存', 'primary')

      if (payload.automation?.fertilizer_buy_organic || payload.automation?.fertilizer_buy_normal) {
        try {
          await api.post('/api/fertilizer/check-and-buy', {
            buyOrganic: payload.automation.fertilizer_buy_organic,
            buyNormal: payload.automation.fertilizer_buy_normal,
            organicCount: payload.fertilizerBuyOrganicCount,
            organicThresholdHours: payload.fertilizerBuyOrganicThresholdHours,
            normalCount: payload.fertilizerBuyNormalCount,
            normalThresholdHours: payload.fertilizerBuyNormalThresholdHours,
          }, {
            headers: { 'x-account-id': accountId },
          })
        }
        catch (e) {
          console.error('检测购买化肥失败', e)
        }
      }
      return true
    }
    else {
      const message = res.unconfirmed && res.saved
        ? `设置已保存，但运行进程尚未确认应用：${res.error || '请稍后重试或重启账号'}`
        : `保存失败: ${res.error}`
      showAlert(message, res.unconfirmed && res.saved ? 'primary' : 'danger')
      return false
    }
  }
  finally {
    if (accountId === currentAccountId.value)
      automationSaving.value = false
  }
}

// 「保存并关闭」要等结果：校验失败时留在弹窗里让用户就地改，别把编辑上下文销毁。
function onFeatureModuleSave(module?: string, quiet?: boolean, done?: (ok: boolean) => void): void {
  handleFeatureModuleSave(module, quiet)
    .then(ok => done?.(ok))
    .catch(() => done?.(false))
}

// ==================== 系统设置 ====================
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
})

const localOffline = ref({
  channel: 'webhook',
  endpoint: '',
  token: '',
  secret: '',
  title: '',
  msg: '',
  offlineDeleteSec: 0,
  smtpHost: '',
  smtpPort: 465,
  smtpUser: '',
  smtpPass: '',
  senderName: '',
  recipientEmail: '',
  emailContent: '',
  useGlobalMailer: false,
})

// 管理员是否已配置好全局邮件服务（用户勾选后免填 SMTP 账号密码）
const globalMailerAvailable = computed(() => settingStore.settings?.globalMailer?.available === true)

const channelOptions = [
  { label: 'SMTP 邮件', value: 'smtp' },
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
  { label: 'MeoW', value: 'meow' },
]

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/orgapp/customize-robot-security-settings',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
  meow: 'https://www.chuckfang.com/MeoW/api_doc.html',
}

const offlineChannel = computed(() => String(localOffline.value.channel || '').trim().toLowerCase())
const isDingTalkChannel = computed(() => offlineChannel.value === 'dingtalk')
const isSmtpChannel = computed(() => offlineChannel.value === 'smtp')
const currentChannelDocUrl = computed(() => CHANNEL_DOCS[offlineChannel.value] || '')

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function syncLocalOfflineSettings() {
  if (settings.value?.offlineReminder) {
    const saved = JSON.parse(JSON.stringify(settings.value.offlineReminder))
    const next = {
      channel: 'webhook',
      endpoint: '',
      token: '',
      secret: '',
      title: '',
      msg: '',
      offlineDeleteSec: 0,
      smtpHost: '',
      smtpPort: 465,
      smtpUser: '',
      smtpPass: '',
      senderName: '',
      recipientEmail: '',
      emailContent: '',
      useGlobalMailer: false,
      ...saved,
    }

    if (String(next.channel || '').trim().toLowerCase() === 'dingtalk') {
      const legacyToken = String(next.token || '').trim()
      if (!String(next.endpoint || '').trim() && legacyToken) {
        next.endpoint = /^https?:\/\//i.test(legacyToken)
          ? legacyToken
          : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(legacyToken)}`
      }
      next.token = ''
    }

    localOffline.value = next
  }
}

function validateDingTalkWebhook(): string {
  if (!isDingTalkChannel.value)
    return ''

  const endpoint = String(localOffline.value.endpoint || '').trim()
  if (!endpoint)
    return '请填写钉钉机器人设置页提供的完整 Webhook 地址'

  try {
    const url = new URL(endpoint)
    const isOfficialWebhook = url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
      && url.pathname === '/robot/send'
      && !!url.searchParams.get('access_token')
    if (!isOfficialWebhook)
      return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }
  catch {
    return '钉钉 Webhook 地址格式不正确，请从群机器人设置页重新复制'
  }

  return ''
}

// 只监听下线提醒本身：保存功能模块设置会整体更新 settings，
// 若对整个 store 做 deep watch，会把通知设置页还没保存的草稿冲掉。
watch(() => settings.value?.offlineReminder, () => {
  syncLocalOfflineSettings()
}, { deep: true })

function validateOfflineForm(): string {
  if (isSmtpChannel.value) {
    // 勾选「使用管理员配置的邮件服务」时免填 SMTP 账号密码
    if (!localOffline.value.useGlobalMailer && !globalMailerAvailable.value) {
      if (!String(localOffline.value.smtpHost || '').trim())
        return '请填写 SMTP 服务器地址（如 smtp.qq.com）'
      if (!String(localOffline.value.smtpUser || '').trim())
        return '请填写发件邮箱账号'
      if (!String(localOffline.value.smtpPass || '').trim())
        return '请填写 SMTP 授权码'
    }
    if (!String(localOffline.value.recipientEmail || '').trim())
      return '请填写收件人邮箱'
    return ''
  }
  return validateDingTalkWebhook()
}

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) {
    showAlert('请填写完整', 'danger')
    return
  }
  if (passwordForm.value.new !== passwordForm.value.confirm) {
    showAlert('两次密码输入不一致', 'danger')
    return
  }
  if (passwordForm.value.new.length < 6) {
    showAlert('密码长度至少6位', 'danger')
    return
  }

  passwordSaving.value = true
  try {
    const res = await userStore.changePassword(passwordForm.value.old, passwordForm.value.new)

    if (res.ok) {
      showAlert('密码修改成功，请重新登录', 'primary')
      passwordForm.value = { old: '', new: '', confirm: '' }
      setTimeout(() => {
        userStore.logout()
        window.location.href = '/login'
      }, 1500)
    }
    else {
      showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    passwordSaving.value = false
  }
}

async function handleSaveOffline() {
  const validationError = validateOfflineForm()
  if (validationError) {
    showAlert(validationError, 'danger')
    return
  }

  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)

    if (res.ok) {
      showAlert('下线提醒设置已保存', 'primary')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    offlineSaving.value = false
  }
}

async function handleTestOffline() {
  const validationError = validateOfflineForm()
  if (validationError) {
    showAlert(validationError, 'danger')
    return
  }

  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    if (data?.ok) {
      showAlert('测试消息发送成功', 'primary')
    }
    else {
      showAlert(`测试失败: ${getApiErrorMessage(data, '未知错误')}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = getApiErrorMessage(e, '请求失败')
    showAlert(`测试失败: ${msg}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}

const systemConfigSaving = ref(false)
const systemConfigLoading = ref(false)
const loginSettingsSaving = ref(false)

const defaultDeviceInfo = {
  os: 'Windows',
  clientVersion: '',
  sysSoftware: 'Windows 10',
  network: 'wifi',
  memory: '16384',
  deviceId: 'DESKTOP-PC<WPC>',
  userAgent: '',
}

const localSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  wxClientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  autoStartAccounts: true,
  deviceInfo: { ...defaultDeviceInfo },
})
const defaultSystemConfig = ref({
  serverUrl: '',
  clientVersion: '',
  wxClientVersion: '',
  platform: 'qq',
  os: 'Windows',
  timeZone: 'Asia/Shanghai',
  autoStartAccounts: true,
  deviceInfo: { ...defaultDeviceInfo },
})
const localLoginSettings = ref({
  wechatQrLogin: true,
  qqQrLogin: false,
  napCatEndpoint: '',
  napCatSignature: '',
})
const devicePresets = ref<any[]>([])
const selectedPresetId = ref('')
const timeZoneOptions = ref([
  { label: '北京时间 / 上海（UTC+8）', value: 'Asia/Shanghai' },
])
const platformOptions = [
  { label: 'QQ', value: 'qq' },
  { label: '微信', value: 'wx' },
]
const osOptions = [
  { label: 'Windows', value: 'Windows' },
  { label: 'iOS', value: 'iOS' },
  { label: 'Android', value: 'Android' },
]

function normalizeSystemConfig(source: any, fallback: any) {
  return {
    serverUrl: source?.serverUrl || '',
    clientVersion: source?.clientVersion || '',
    wxClientVersion: source?.wxClientVersion || fallback.wxClientVersion || '',
    platform: source?.platform || 'qq',
    os: source?.os || 'Windows',
    timeZone: source?.timeZone || fallback.timeZone || 'Asia/Shanghai',
    autoStartAccounts: source?.autoStartAccounts !== false,
    deviceInfo: source?.deviceInfo ? { ...fallback.deviceInfo, ...source.deviceInfo } : { ...fallback.deviceInfo },
  }
}

function normalizeLoginSettings(source: any) {
  return {
    wechatQrLogin: typeof source?.wechatQrLogin === 'boolean' ? source.wechatQrLogin : true,
    qqQrLogin: typeof source?.qqQrLogin === 'boolean' ? source.qqQrLogin : false,
    napCatEndpoint: typeof source?.napCatEndpoint === 'string' ? source.napCatEndpoint.trim() : '',
    napCatSignature: typeof source?.napCatSignature === 'string' ? source.napCatSignature.trim() : '',
  }
}

async function loadDevicePresets() {
  try {
    const { data } = await api.get('/api/settings/device-presets')
    if (data?.ok && Array.isArray(data.data))
      devicePresets.value = data.data
  }
  catch (e) {
    console.error('加载设备预设失败:', e)
  }
}

function applyDevicePreset(presetId: string) {
  const preset = devicePresets.value.find(item => item.id === presetId)
  if (!preset)
    return
  const deviceInfo = { ...defaultDeviceInfo, ...(preset.deviceInfo || {}) }
  localSystemConfig.value = {
    ...localSystemConfig.value,
    os: deviceInfo.os || 'Windows',
    clientVersion: deviceInfo.clientVersion || '',
    deviceInfo,
  }
  selectedPresetId.value = presetId
}

async function loadSystemConfig() {
  systemConfigLoading.value = true
  try {
    const { data } = await api.get('/api/settings/system-config')
    if (data?.ok) {
      if (Array.isArray(data.data.timeZones) && data.data.timeZones.length) {
        timeZoneOptions.value = data.data.timeZones.map((option: any) => ({
          label: String(option.label || option.value || ''),
          value: String(option.value || 'Asia/Shanghai'),
        }))
      }
      defaultSystemConfig.value = normalizeSystemConfig(data.data.default, defaultSystemConfig.value)
      localSystemConfig.value = normalizeSystemConfig(data.data.saved || data.data.default, defaultSystemConfig.value)
      localLoginSettings.value = normalizeLoginSettings(data.data.loginSettings)
    }
  }
  catch (e) {
    console.error('加载系统配置失败:', e)
  }
  finally {
    systemConfigLoading.value = false
  }
}

async function handleSaveLoginSettings() {
  if (localLoginSettings.value.qqQrLogin
    && (!localLoginSettings.value.napCatEndpoint.trim() || !localLoginSettings.value.napCatSignature.trim())) {
    showAlert('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名', 'danger')
    return
  }
  loginSettingsSaving.value = true
  try {
    const { data } = await api.post('/api/settings/login-config', localLoginSettings.value)
    if (data?.ok) {
      localLoginSettings.value = normalizeLoginSettings(data.data)
    }
    showAlert(data?.ok ? '登录设置已保存' : getApiErrorMessage(data, '保存失败'), data?.ok ? 'primary' : 'danger')
  }
  catch (e: any) {
    showAlert(`保存失败: ${getApiErrorMessage(e, '未知错误')}`, 'danger')
  }
  finally {
    loginSettingsSaving.value = false
  }
}

async function handleSaveSystemConfig() {
  systemConfigSaving.value = true
  try {
    localSystemConfig.value.clientVersion = localSystemConfig.value.deviceInfo.clientVersion
    localSystemConfig.value.os = localSystemConfig.value.deviceInfo.os
    const { data } = await api.post('/api/settings/system-config', localSystemConfig.value)
    showAlert(data?.ok ? '系统配置已保存，连接参数在下次登录时生效' : getApiErrorMessage(data, '保存失败'), data?.ok ? 'primary' : 'danger')
  }
  catch (e: any) {
    showAlert(`保存失败: ${getApiErrorMessage(e, '未知错误')}`, 'danger')
  }
  finally {
    systemConfigSaving.value = false
  }
}

async function handleResetSystemConfig() {
  systemConfigSaving.value = true
  try {
    const { data } = await api.post('/api/settings/system-config/reset')
    if (data?.ok) {
      localSystemConfig.value = normalizeSystemConfig(data.data.saved, defaultSystemConfig.value)
      selectedPresetId.value = ''
      showAlert('系统配置已重置，连接参数在下次登录时生效', 'primary')
    }
    else {
      showAlert(getApiErrorMessage(data, '重置失败'), 'danger')
    }
  }
  catch (e: any) {
    showAlert(`重置失败: ${getApiErrorMessage(e, '未知错误')}`, 'danger')
  }
  finally {
    systemConfigSaving.value = false
  }
}

// ==================== 版本更新与回滚（当前 fork 独有） ====================
interface IncomingCommitItem {
  hash: string
  shortHash: string
  subject: string
  author: string
  timestampMs: number
}

interface PanelUpdateJob {
  id: string
  pid?: number
  status: 'running' | 'succeeded' | 'failed'
  phase: string
  detail?: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  exitCode?: number | null
  error?: string
  fromCommit?: string
  targetCommit?: string
  recentLines: string[]
}

interface SystemUpdateState {
  mode: 'source' | 'docker' | 'binary' | 'unknown'
  gitSupported: boolean
  unsupportedReason: string
  applySupported: boolean
  applyUnsupportedReason: string
  branch: string
  detached: boolean
  commit: string
  shortCommit: string
  commitSubject: string
  startupCommit: string
  needsApply: boolean
  updateHint: string
  hostMaintenance: string
  upstream: string
  remote: string
  remoteBranch: string
  behindCount: number
  aheadCount: number
  dirtyFiles: string[]
  incomingCommits: IncomingCommitItem[]
  canCheck: boolean
  canPull: boolean
  canApply: boolean
  deployBusy: boolean
  lastCheckedAt: number | null
  lastCheckError: string
  lastPulledAt: number | null
  job: PanelUpdateJob | null
  releases: RollbackReleaseItem[]
  releasesSummary: ReleasesSummary
  keepBackups?: boolean
}

const emptyReleasesSummary: ReleasesSummary = {
  totalCount: 0,
  compatibleCount: 0,
  outdatedCount: 0,
  totalSizeBytes: 0,
  outdatedSizeBytes: 0,
  orphanHostCount: 0,
  orphanWebCount: 0,
  orphanSizeBytes: 0,
}

const updateStatus = ref<SystemUpdateState | null>(null)
const updateLoading = ref(false)
const updateChecking = ref(false)
const updatePulling = ref(false)
const updateApplying = ref(false)
const updateActionError = ref('')
const updateRequestConfig = { skipErrorToast: true, timeout: 90_000 }
let updateViewActive = true
let updatePollTimer: ReturnType<typeof setTimeout> | null = null

function handleReleaseStatusUpdated(nextStatus: SystemUpdateState) {
  updateStatus.value = nextStatus
  scheduleUpdatePollIfBusy()
}

function clearUpdatePollTimer() {
  if (updatePollTimer) {
    clearTimeout(updatePollTimer)
    updatePollTimer = null
  }
}

function scheduleUpdatePollIfBusy() {
  clearUpdatePollTimer()
  if (!updateViewActive)
    return
  const status = updateStatus.value
  if (status?.job?.status === 'running' || status?.deployBusy) {
    updatePollTimer = setTimeout(() => {
      void loadUpdateStatus({ silent: true })
    }, 2000)
  }
}

async function loadUpdateStatus(options: { silent?: boolean } = {}) {
  if (!options.silent) {
    updateActionError.value = ''
    updateLoading.value = true
  }
  try {
    const { data } = await api.get('/api/system/update/status', updateRequestConfig)
    if (data?.ok && data.data) {
      updateStatus.value = data.data
      scheduleUpdatePollIfBusy()
    }
  }
  catch (e: any) {
    if (!options.silent)
      updateActionError.value = getApiErrorMessage(e, '获取更新状态失败')
    if (updateStatus.value?.job?.status === 'running')
      scheduleUpdatePollIfBusy()
  }
  finally {
    if (!options.silent)
      updateLoading.value = false
  }
}

async function handleCheckSystemUpdates() {
  updateChecking.value = true
  updateActionError.value = ''
  try {
    const { data } = await api.post('/api/system/update/check', {}, updateRequestConfig)
    if (data?.ok && data.data) {
      updateStatus.value = data.data
      scheduleUpdatePollIfBusy()
      if (data.data.behindCount > 0)
        toast.info(`发现 ${data.data.behindCount} 个可拉取更新`)
      else if (data.data.needsApply)
        toast.info(data.data.updateHint)
      else
        toast.success('当前分支已是最新')
    }
    else {
      updateActionError.value = getApiErrorMessage(data, '检查更新失败')
    }
  }
  catch (e: any) {
    updateActionError.value = getApiErrorMessage(e, '检查更新失败')
  }
  finally {
    updateChecking.value = false
  }
}

async function handlePullSystemUpdates() {
  updatePulling.value = true
  updateActionError.value = ''
  try {
    const { data } = await api.post('/api/system/update/pull', {}, updateRequestConfig)
    if (data?.ok && data.data?.status) {
      updateStatus.value = data.data.status
      scheduleUpdatePollIfBusy()
      if (data.data.pulled)
        toast.success(`代码已更新到 ${data.data.toCommit}`)
      else
        toast.info('当前没有可拉取的提交')
    }
    else {
      updateActionError.value = getApiErrorMessage(data, '拉取更新失败')
    }
  }
  catch (e: any) {
    updateActionError.value = getApiErrorMessage(e, '拉取更新失败')
  }
  finally {
    updatePulling.value = false
  }
}

async function handleApplySystemUpdate(pullFirst: boolean) {
  updateApplying.value = true
  updateActionError.value = ''
  try {
    const { data } = await api.post('/api/system/update/apply', { pullFirst }, updateRequestConfig)
    if (data?.ok && data.data?.status) {
      updateStatus.value = data.data.status
      scheduleUpdatePollIfBusy()
      if (data.data.job)
        toast.info('已开始更新，准备新版期间可以继续使用面板')
      else
        toast.success('网页端和服务端均无需更新')
    }
    else {
      updateActionError.value = getApiErrorMessage(data, '启动在线更新失败')
    }
  }
  catch (e: any) {
    updateActionError.value = getApiErrorMessage(e, '启动在线更新失败')
  }
  finally {
    updateApplying.value = false
  }
}

/** 标题行的一句话状态，按任务、待更新、本地异常、最新的优先级取一项。 */
const updateHeadline = computed<{ label: string, tone: 'busy' | 'pending' | 'warn' | 'ok' | 'muted' }>(() => {
  const status = updateStatus.value
  if (!status)
    return { label: '', tone: 'muted' }
  if (status.job?.status === 'running' || status.deployBusy)
    return { label: '更新中', tone: 'busy' }
  if (!status.gitSupported)
    return { label: '不支持在线更新', tone: 'muted' }
  if (status.behindCount > 0)
    return { label: `${status.behindCount} 个可更新`, tone: 'pending' }
  if (status.needsApply)
    return { label: '待应用', tone: 'pending' }
  if (status.dirtyFiles.length || status.aheadCount > 0)
    return { label: '本地有改动', tone: 'warn' }
  if (status.hostMaintenance)
    return { label: '游戏连接服务', tone: 'muted' }
  if (!status.lastCheckedAt)
    return { label: '未检查', tone: 'muted' }
  return { label: '已是最新', tone: 'ok' }
})

function formatUpdateTimestamp(ms: number | null | undefined): string {
  if (!ms)
    return '未检查'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

watch(() => statusStore.realtimeReconnectCount, (count) => {
  if (count <= 0)
    return
  void loadUpdateStatus({ silent: true })
  void appUpdateStore.checkVersionNow(true)
})

onBeforeUnmount(() => {
  updateViewActive = false
  clearUpdatePollTimer()
})
</script>

<template>
  <div class="settings-page page-stack">
    <div class="settings-workspace">
      <aside class="settings-navigation">
        <div class="settings-navigation-label">
          账号与偏好
        </div>
        <nav ref="tabsNav" class="settings-categories" aria-label="设置分类">
          <button
            v-for="tab in visibleTabs"
            :key="tab.key"
            :data-settings-tab="tab.key"
            class="settings-category"
            :aria-pressed="activeTab === tab.key"
            @click="setActiveTab(tab.key)"
          >
            <div :class="tab.icon" />
            {{ tab.label }}
          </button>
        </nav>
      </aside>

      <div class="settings-body">
        <!-- 账号管理 -->
        <AccountManagementPanel v-if="activeTab === 'account'" @open-settings="openAccountSettings" />

        <!-- 好友申请：分享卡片号池 + 主动加好友（BUGDey v2.18.12） -->
        <FriendApplyTab v-else-if="activeTab === 'friend-apply'" />

        <!-- 农场设置：原「账号设置」的农场模块（种植/土地/好友/偷菜/商人/日常） -->
        <div v-else-if="activeTab === 'farm-config'" class="space-y-4">
          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId || loadedAccountId !== currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
            <p>{{ currentAccountId ? '农场设置加载失败，请切换账号或刷新页面重试' : '请先选择账号' }}</p>
          </div>

          <AccountFeatureSettings
            v-else
            v-model:strategy="localStrategySettings"
            v-model:automation="localAutomationSettings"
            group="farm"
            :current-account-name="currentAccountName"
            :current-account-id="currentAccountId"
            :loading="settingsLoading"
            :saving="automationSaving"
            :planting-strategy-options="plantingStrategyOptions"
            :bag-fallback-strategy-options="BAG_FALLBACK_STRATEGY_OPTIONS"
            :fertilizer-land-type-options="fertilizerLandTypeOptions"
            :fertilizer-options="fertilizerOptions"
            @save="onFeatureModuleSave"
          />
        </div>

        <!-- 牧场设置：原「账号设置」的牧场模块（养殖/饲料/好友/偷取/集市/日常） -->
        <div v-else-if="activeTab === 'ranch-config'" class="space-y-4">
          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId || loadedAccountId !== currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
            <p>{{ currentAccountId ? '牧场设置加载失败，请切换账号或刷新页面重试' : '请先选择账号' }}</p>
          </div>

          <AccountFeatureSettings
            v-else
            v-model:strategy="localStrategySettings"
            v-model:automation="localAutomationSettings"
            group="ranch"
            :current-account-name="currentAccountName"
            :current-account-id="currentAccountId"
            :loading="settingsLoading"
            :saving="automationSaving"
            :planting-strategy-options="plantingStrategyOptions"
            :bag-fallback-strategy-options="BAG_FALLBACK_STRATEGY_OPTIONS"
            :fertilizer-land-type-options="fertilizerLandTypeOptions"
            :fertilizer-options="fertilizerOptions"
            @save="onFeatureModuleSave"
          />
        </div>

        <!-- 活动设置：原「账号设置」的活动模块（节令小札/牧歌初启/奶茶/快乐不独享） -->
        <div v-else-if="activeTab === 'activity-config'" class="space-y-4">
          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId || loadedAccountId !== currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings mx-auto mb-2 text-3xl text-gray-400" />
            <p>{{ currentAccountId ? '活动设置加载失败，请切换账号或刷新页面重试' : '请先选择账号' }}</p>
          </div>

          <AccountFeatureSettings
            v-else
            v-model:strategy="localStrategySettings"
            v-model:automation="localAutomationSettings"
            group="events"
            :current-account-name="currentAccountName"
            :current-account-id="currentAccountId"
            :loading="settingsLoading"
            :saving="automationSaving"
            :planting-strategy-options="plantingStrategyOptions"
            :bag-fallback-strategy-options="BAG_FALLBACK_STRATEGY_OPTIONS"
            :fertilizer-land-type-options="fertilizerLandTypeOptions"
            :fertilizer-options="fertilizerOptions"
            @save="onFeatureModuleSave"
          />
        </div>

        <!-- 通知设置 -->
        <div v-else-if="activeTab === 'notification'" class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
                通知设置
              </h3>
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                配置账号离线后的通知渠道和消息内容。
              </p>
            </div>
            <BaseButton
              size="sm"
              :loading="offlineSaving"
              :disabled="offlineTesting"
              @click="handleSaveOffline"
            >
              保存通知设置
            </BaseButton>
          </div>

          <OfflineReminderCard
            v-model:config="localOffline"
            :channel-options="channelOptions"
            :current-channel-doc-url="currentChannelDocUrl"
            :saving="offlineSaving"
            :testing="offlineTesting"
            :show-save="false"
            :global-mailer-available="globalMailerAvailable"
            @open-docs="openChannelDocs"
            @test="handleTestOffline"
            @save="handleSaveOffline"
          />
        </div>

        <!-- 全局设置 -->
        <div v-else-if="activeTab === 'system-settings'" class="space-y-4">
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            全局设置
          </h3>
          <p class="text-xs text-gray-500 -mt-2 dark:text-gray-400">
            服务器连接、时区与客户端设备参数，保存后下次登录生效
          </p>

          <section class="farm-card rounded-lg p-4">
            <div class="mb-4 flex items-start gap-3">
              <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
                <span class="i-carbon-settings-adjust text-xl" />
              </div>
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  运行环境
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  服务器连接、时区与客户端设备参数
                </p>
              </div>
            </div>

            <div v-if="systemConfigLoading" class="py-8 text-center text-gray-500">
              <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
            </div>
            <div v-else class="space-y-3">
              <div v-if="devicePresets.length" class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">设备预设</label>
                <div class="flex flex-wrap gap-2">
                  <NButton
                    v-for="preset in devicePresets"
                    :key="preset.id"
                    size="small"
                    :type="selectedPresetId === preset.id ? 'primary' : 'default'"
                    :secondary="selectedPresetId !== preset.id"
                    :title="preset.description"
                    @click="applyDevicePreset(preset.id)"
                  >
                    {{ preset.name }}
                  </NButton>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput
                  v-model="localSystemConfig.serverUrl"
                  label="服务器地址"
                  type="text"
                  placeholder="wss://..."
                />
                <div>
                  <BaseSelect
                    v-model="localSystemConfig.timeZone"
                    label="系统时区"
                    :options="timeZoneOptions"
                  />
                  <p class="mt-1 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
                    礼包、任务、安静时段和日志均以此时区为准。
                  </p>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                  <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">平台</label>
                  <div class="flex flex-wrap gap-2">
                    <NButton
                      v-for="option in platformOptions"
                      :key="option.value"
                      size="small"
                      :type="localSystemConfig.platform === option.value ? 'primary' : 'default'"
                      :secondary="localSystemConfig.platform !== option.value"
                      @click="localSystemConfig.platform = option.value"
                    >
                      {{ option.label }}
                    </NButton>
                  </div>
                </div>
                <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                  <label class="mb-2 block text-sm text-gray-700 font-medium dark:text-gray-300">系统</label>
                  <div class="flex flex-wrap gap-2">
                    <NButton
                      v-for="option in osOptions"
                      :key="option.value"
                      size="small"
                      :type="localSystemConfig.deviceInfo.os === option.value ? 'primary' : 'default'"
                      :secondary="localSystemConfig.deviceInfo.os !== option.value"
                      @click="localSystemConfig.deviceInfo.os = option.value; localSystemConfig.os = option.value"
                    >
                      {{ option.label }}
                    </NButton>
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.clientVersion"
                  label="QQ 客户端版本"
                  type="text"
                  :placeholder="defaultSystemConfig.deviceInfo.clientVersion || '从服务器加载中...'"
                />
                <BaseInput
                  v-model="localSystemConfig.wxClientVersion"
                  label="微信客户端版本"
                  type="text"
                  :placeholder="defaultSystemConfig.wxClientVersion || '从服务器加载中...'"
                />
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.sysSoftware"
                  label="系统版本"
                  type="text"
                  placeholder="Windows 10"
                />
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.deviceId"
                  label="设备标识"
                  type="text"
                  placeholder="DESKTOP-PC<WPC>"
                />
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.memory"
                  label="内存 (MB)"
                  type="text"
                  placeholder="16384"
                />
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.network"
                  label="网络"
                  type="text"
                  placeholder="wifi"
                />
                <BaseInput
                  v-model="localSystemConfig.deviceInfo.userAgent"
                  label="User-Agent"
                  type="text"
                  placeholder="Mozilla/5.0 ..."
                />
              </div>

              <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
                <BaseButton variant="primary" size="sm" :loading="systemConfigSaving" @click="handleResetSystemConfig">
                  重置
                </BaseButton>
                <BaseButton variant="primary" size="sm" :loading="systemConfigSaving" @click="handleSaveSystemConfig">
                  保存运行环境
                </BaseButton>
              </div>
            </div>
          </section>

          <section class="farm-card rounded-lg p-4">
            <div class="mb-4 flex items-start gap-3">
              <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
                <span class="i-carbon-password text-xl" />
              </div>
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  修改管理员密码
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  更新后台管理登录凭据
                </p>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <BaseInput
                v-model="passwordForm.old"
                label="当前密码"
                type="password"
                placeholder="当前管理员密码"
              />
              <BaseInput
                v-model="passwordForm.new"
                label="新密码"
                type="password"
                placeholder="至少 6 位"
              />
              <BaseInput
                v-model="passwordForm.confirm"
                label="确认新密码"
                type="password"
                placeholder="再次输入新密码"
              />
            </div>

            <div class="mt-3 flex items-center justify-end border-t pt-3 dark:border-gray-700">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="passwordSaving"
                @click="handleChangePassword"
              >
                修改管理员密码
              </BaseButton>
            </div>
          </section>

          <section class="system-update-card min-w-0 farm-card rounded-lg p-4">
            <div class="mb-4 flex items-start gap-3">
              <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400">
                <span class="i-carbon-renew text-xl" />
              </div>
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  版本更新
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  检查分支更新、拉取代码与回滚历史版本
                </p>
              </div>
            </div>

            <div v-if="updateLoading && !updateStatus" class="py-6 text-center text-gray-500">
              <span class="i-svg-spinners-90-ring-with-bg inline-block text-2xl" />
            </div>
            <div v-else-if="updateStatus" class="update-workspace">
              <section class="update-pane update-pane--status" aria-labelledby="update-status-title">
                <header class="update-pane__head">
                  <div class="update-pane__heading">
                    <h5 id="update-status-title" class="update-pane__title">
                      当前版本
                    </h5>
                    <span class="update-state" :class="`update-state--${updateHeadline.tone}`">
                      <span v-if="updateHeadline.tone === 'busy'" class="i-svg-spinners-90-ring-with-bg" aria-hidden="true" />
                      {{ updateHeadline.label }}
                    </span>
                  </div>
                  <div class="update-pane__actions">
                    <BaseButton
                      variant="secondary"
                      size="sm"
                      :loading="updateChecking"
                      :disabled="!updateStatus.canCheck || updatePulling || updateApplying || updateStatus.deployBusy"
                      @click="handleCheckSystemUpdates"
                    >
                      <span class="i-carbon-renew mr-1" aria-hidden="true" />检查更新
                    </BaseButton>
                    <BaseButton
                      v-if="updateStatus.canPull"
                      variant="secondary"
                      size="sm"
                      :loading="updatePulling"
                      :disabled="updateChecking || updateApplying || updateStatus.deployBusy"
                      @click="handlePullSystemUpdates"
                    >
                      仅拉取代码
                    </BaseButton>
                    <BaseButton
                      v-if="updateStatus.applySupported && updateStatus.behindCount > 0"
                      variant="primary"
                      size="sm"
                      :loading="updateApplying"
                      :disabled="!updateStatus.canApply || updateChecking || updatePulling"
                      @click="handleApplySystemUpdate(true)"
                    >
                      拉取并更新
                    </BaseButton>
                    <BaseButton
                      v-else-if="updateStatus.applySupported && updateStatus.needsApply"
                      variant="primary"
                      size="sm"
                      :loading="updateApplying"
                      :disabled="!updateStatus.canApply || updateChecking || updatePulling"
                      @click="handleApplySystemUpdate(false)"
                    >
                      应用更新
                    </BaseButton>
                  </div>
                </header>

                <dl class="update-facts">
                  <div class="update-fact">
                    <dt>分支</dt>
                    <dd class="update-fact__value font-mono">
                      <span>{{ updateStatus.detached ? '游离 HEAD' : (updateStatus.branch || '-') }}</span>
                      <span class="update-fact__muted" aria-label="跟踪">→</span>
                      <span :class="{ 'update-fact__muted': !updateStatus.upstream }">{{ updateStatus.upstream || '未关联远程' }}</span>
                    </dd>
                  </div>
                  <div class="update-fact">
                    <dt>提交</dt>
                    <dd class="update-fact__value" :title="updateStatus.commitSubject || undefined">
                      <code class="update-fact__sha">{{ updateStatus.shortCommit || '-' }}</code>
                      <span v-if="updateStatus.commitSubject" class="update-fact__subject">{{ updateStatus.commitSubject }}</span>
                    </dd>
                  </div>
                  <div class="update-fact">
                    <dt>最近检查</dt>
                    <dd class="update-fact__value">
                      {{ formatUpdateTimestamp(updateStatus.lastCheckedAt) }}
                    </dd>
                  </div>
                </dl>

                <div v-if="!updateStatus.gitSupported" class="update-notice update-notice--muted">
                  {{ updateStatus.unsupportedReason }}
                </div>

                <template v-else>
                  <div v-if="updateStatus.dirtyFiles.length" class="update-notice update-notice--warn">
                    检测到未提交的本地修改（{{ updateStatus.dirtyFiles.slice(0, 3).join('，') }}{{ updateStatus.dirtyFiles.length > 3 ? ' 等' : '' }}），已禁用自动拉取以避免覆盖。
                  </div>

                  <div v-if="updateStatus.aheadCount > 0" class="update-notice update-notice--warn">
                    当前分支领先远程 {{ updateStatus.aheadCount }} 个提交，无法快进拉取（--ff-only）。
                  </div>

                  <div v-if="updateStatus.needsApply && updateStatus.behindCount === 0" class="update-notice update-notice--info">
                    工作区代码已更新（运行基线 {{ updateStatus.startupCommit.slice(0, 7) }} → {{ updateStatus.shortCommit }}），应用更新并重启后端后生效。
                  </div>

                  <div v-if="updateStatus.behindCount > 0" class="update-block">
                    <div class="update-block__title">
                      可拉取更新<span class="update-block__count">{{ updateStatus.behindCount }}</span>
                    </div>
                    <ul class="update-commits">
                      <li v-for="item in updateStatus.incomingCommits" :key="item.hash" class="update-commits__row">
                        <code class="update-commits__sha">{{ item.shortHash }}</code>
                        <span class="update-commits__subject" :title="item.subject">{{ item.subject }}</span>
                        <span class="update-commits__author">{{ item.author }}</span>
                      </li>
                    </ul>
                  </div>

                  <div v-if="!updateStatus.applySupported && updateStatus.applyUnsupportedReason" class="update-notice update-notice--muted">
                    {{ updateStatus.applyUnsupportedReason }}
                  </div>
                </template>

                <div
                  v-if="updateStatus.job"
                  class="update-block update-job"
                  :class="`update-job--${updateStatus.job.status}`"
                  role="status"
                >
                  <div class="update-block__title">
                    <span
                      v-if="updateStatus.job.status === 'running'"
                      class="update-job__icon i-svg-spinners-90-ring-with-bg"
                      aria-hidden="true"
                    />
                    <span
                      v-else-if="updateStatus.job.status === 'succeeded'"
                      class="update-job__icon i-carbon-checkmark-filled"
                      aria-hidden="true"
                    />
                    <span v-else class="update-job__icon i-carbon-warning-filled" aria-hidden="true" />
                    <span class="min-w-0 truncate">
                      {{ updateStatus.job.phase || '更新任务' }}{{ updateStatus.job.detail ? ` · ${updateStatus.job.detail}` : '' }}
                    </span>
                  </div>
                  <div v-if="updateStatus.job.error" class="update-job__error">
                    {{ updateStatus.job.error }}
                  </div>
                  <pre v-if="updateStatus.job.recentLines?.length" class="update-job__log">{{ updateStatus.job.recentLines.slice(-6).join('\n') }}</pre>
                </div>

                <div v-if="updateActionError || updateStatus.lastCheckError" role="alert" class="update-error">
                  {{ updateActionError || updateStatus.lastCheckError }}
                </div>
              </section>

              <ReleaseRollbackPanel
                class="update-pane update-pane--releases"
                :releases="updateStatus.releases || []"
                :summary="updateStatus.releasesSummary || emptyReleasesSummary"
                :mode="updateStatus.mode"
                :apply-supported="updateStatus.applySupported"
                :apply-unsupported-reason="updateStatus.applyUnsupportedReason"
                :deploy-busy="updateStatus.deployBusy"
                :disabled="updateChecking || updatePulling || updateApplying"
                @status-updated="handleReleaseStatusUpdated"
              />
            </div>
            <div v-else-if="updateActionError" class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-red-600 dark:text-red-400">{{ updateActionError }}</span>
              <BaseButton size="sm" variant="secondary" @click="loadUpdateStatus()">
                重新加载
              </BaseButton>
            </div>
          </section>
        </div>

        <!-- 连接与设备 -->
        <div v-else-if="activeTab === 'system'" class="space-y-4">
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            连接与设备
          </h3>
          <p class="text-xs text-gray-500 -mt-2 dark:text-gray-400">
            添加账号时可用的扫码登录方式与 NapCat 接口参数
          </p>

          <section class="farm-card rounded-lg p-4">
            <div class="mb-4 flex items-start gap-3">
              <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-900/25 dark:text-violet-400">
                <span class="i-carbon-login text-xl" />
              </div>
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  登录设置
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  控制添加账号时可用的扫码登录方式
                </p>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                <BaseSwitch v-model="localLoginSettings.wechatQrLogin" label="微信扫码登录" />
              </div>
              <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/30">
                <BaseSwitch v-model="localLoginSettings.qqQrLogin" label="QQ扫码登录" />
              </div>
            </div>

            <div
              v-if="localLoginSettings.qqQrLogin"
              class="grid grid-cols-1 mt-4 gap-3 border border-gray-200 rounded-lg bg-gray-50/70 p-4 sm:grid-cols-2 dark:border-gray-700 dark:bg-gray-900/30"
            >
              <BaseInput
                v-model="localLoginSettings.napCatEndpoint"
                label="NapCat接口地址"
                type="text"
                placeholder="http://127.0.0.1:6099"
              />
              <BaseInput
                v-model="localLoginSettings.napCatSignature"
                label="NapCat接口签名"
                type="password"
                placeholder="请输入 NapCat 接口签名"
              />
            </div>

            <div class="mt-3 flex justify-end border-t pt-3 dark:border-gray-700">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="loginSettingsSaving"
                @click="handleSaveLoginSettings"
              >
                保存登录设置
              </BaseButton>
            </div>
          </section>
        </div>

        <!-- 我的账号（订阅 / 卡密 / 邀请，当前 fork 独有） -->
        <div v-else-if="activeTab === 'my-account'" class="space-y-4">
          <!-- 微信定时刷新重登：仅微信账号显示 -->
          <div v-if="currentAccountIsWx" class="farm-card rounded-lg p-4">
            <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h4 class="flex items-center gap-2 text-sm text-gray-900 font-semibold dark:text-gray-100">
                  <span class="i-carbon-renew text-base" />
                  微信定时刷新重登
                  <span v-if="currentAccountName" class="text-xs text-gray-500 font-normal dark:text-gray-400">
                    ({{ currentAccountName }})
                  </span>
                </h4>
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  此处按账号保存，并非全局设置。
                </p>
              </div>
              <BaseButton
                size="sm"
                :loading="autoCodeSaving"
                :disabled="!currentAccountId || settingsLoading"
                @click="handleSaveAutoCodeRefresh"
              >
                保存刷新设置
              </BaseButton>
            </div>

            <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/20">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div class="min-w-0 space-y-2">
                  <BaseSwitch v-model="localAutoCodeRefresh.enabled" label="启用定时刷新与自动重登" />
                  <p class="max-w-3xl text-xs text-gray-500 leading-relaxed dark:text-gray-400">
                    <template v-if="!currentAccountHasCredential">
                      <span class="text-amber-700 font-semibold dark:text-amber-300">当前账号缺少登录凭据（需重新扫码添加）。</span>
                    </template>
                    <template v-else>
                      <span class="text-amber-700 font-semibold dark:text-amber-300">仅带内置登录凭据的微信扫码账号可用。</span>
                    </template>
                    启用后会按间隔获取新 Code 并重启账号；账号被踢、断线或 Code 失效时，也会按阶梯延迟自动重登。
                    关闭不会停用启动时刷新、Code 失效时的即时恢复和微信凭证保活。
                  </p>
                </div>

                <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <BaseInput
                    v-model.number="localAutoCodeRefresh.intervalMinutes"
                    label="间隔(分钟)"
                    type="number"
                    min="1"
                    max="1440"
                    placeholder="60"
                    class="sm:w-36"
                  />
                  <BaseButton
                    variant="secondary"
                    size="sm"
                    class="h-9 whitespace-nowrap"
                    :loading="autoCodeRefreshing"
                    :disabled="autoCodeSaving || !currentAccountHasCredential"
                    @click="handleRefreshCodeNow"
                  >
                    <span class="i-carbon-renew mr-1" />
                    立即刷新
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>

          <!-- 我的账户：账户信息 / 卡密续费 / 我的农场账号 / 邀请好友 / 核销记录 -->
          <div class="farm-card rounded-lg p-4">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  我的账户
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {{ userStore.username }} ·
                  {{ userStore.isAdmin ? '超级管理员（不限额度、永久有效）' : '普通用户' }}
                </p>
              </div>
              <span
                class="rounded-full px-3 py-1 text-xs font-medium"
                :class="userStore.isExpired
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'"
              >
                {{ userStore.isExpired ? '已过期' : '有效' }}
              </span>
            </div>
            <div class="grid grid-cols-1 mt-4 gap-3 sm:grid-cols-3">
              <div class="rounded-xl bg-gray-50/80 p-3 dark:bg-gray-900/40">
                <div class="text-xs text-gray-500">
                  到期时间
                </div>
                <div class="mt-1 text-sm text-gray-900 font-semibold dark:text-gray-100">
                  {{ formatExpiresAt(userStore.subscription) }}
                </div>
              </div>
              <div class="rounded-xl bg-gray-50/80 p-3 dark:bg-gray-900/40">
                <div class="text-xs text-gray-500">
                  剩余时长
                </div>
                <div class="mt-1 text-sm text-gray-900 font-semibold dark:text-gray-100">
                  {{ myRemainingText }}
                </div>
              </div>
              <div class="rounded-xl bg-gray-50/80 p-3 dark:bg-gray-900/40">
                <div class="text-xs text-gray-500">
                  农场账号额度
                </div>
                <div class="mt-1 text-sm text-gray-900 font-semibold dark:text-gray-100">
                  {{ myUnlimited
                    ? `${myAccountUsed} / 不限`
                    : `${myAccountUsed} / ${userStore.accountLimit}（剩余 ${myAccountRemaining}）` }}
                </div>
              </div>
            </div>
          </div>

          <!-- 修改密码：只改当前登录账号自己的密码 -->
          <section class="farm-card rounded-lg p-4">
            <div class="mb-4 flex items-start gap-3">
              <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-900/25 dark:text-amber-400">
                <span class="i-carbon-password text-xl" />
              </div>
              <div>
                <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                  修改密码
                </h4>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  修改当前登录账号（{{ userStore.username }}）的登录密码
                </p>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-3">
              <BaseInput v-model="passwordForm.old" label="当前密码" type="password" placeholder="输入当前登录密码" />
              <BaseInput v-model="passwordForm.new" label="新密码" type="password" placeholder="至少 6 位" />
              <BaseInput v-model="passwordForm.confirm" label="确认新密码" type="password" placeholder="再次输入新密码" />
            </div>

            <div class="mt-3 flex items-center justify-end border-t pt-3 dark:border-gray-700">
              <BaseButton variant="primary" size="sm" :loading="passwordSaving" @click="handleChangePassword">
                保存新密码
              </BaseButton>
            </div>
          </section>

          <div class="farm-card rounded-lg p-4">
            <h4 class="mb-3 flex items-center gap-2 text-sm text-gray-900 font-semibold dark:text-gray-100">
              <span class="i-carbon-gift text-base" />
              卡密续费
            </h4>
            <div class="flex flex-wrap items-center gap-2">
              <BaseInput
                v-model="cardCode"
                class="min-w-56 flex-1"
                type="text"
                placeholder="输入卡密，加时卡延长有效期、额度卡提升账号配额"
                @keyup.enter="handleRenewCard"
              />
              <BaseButton variant="primary" size="sm" :loading="cardSubmitting" @click="handleRenewCard">
                立即核销
              </BaseButton>
            </div>
            <p class="mt-2 text-[11px] text-gray-400">
              加时卡在未过期时会顺延有效期；已过期则从当前时间重新起算。永久卡优先级最高。
            </p>
          </div>

          <div class="farm-card rounded-lg p-4">
            <div class="mb-3 flex items-center justify-between">
              <h4 class="flex items-center gap-2 text-sm text-gray-900 font-semibold dark:text-gray-100">
                <span class="i-carbon-user-multiple text-base" />
                我的农场账号
              </h4>
              <span class="text-xs text-gray-400">仅显示我添加的账号 · 点击卡片可切换</span>
            </div>
            <div v-if="myAccounts.length === 0" class="py-6 text-center text-sm text-gray-400">
              暂无农场账号，请在上方账号管理中添加
            </div>
            <div v-else class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div
                v-for="acc in myAccounts"
                :key="acc.id"
                class="flex cursor-pointer items-center justify-between border rounded-xl px-3 py-2.5 transition hover:bg-gray-50 dark:hover:bg-gray-700/40"
                style="border-color: var(--surface-border);"
                @click="configMyAccount(acc)"
              >
                <div class="min-w-0">
                  <div class="truncate text-sm text-gray-900 font-medium dark:text-gray-100">
                    {{ acc.name || acc.nick || `账号 ${acc.id}` }}
                  </div>
                  <div class="text-[11px] text-gray-400">
                    ID {{ acc.id }} · {{ acc.platform || '-' }}
                  </div>
                </div>
                <span class="text-xs text-[var(--theme-primary)]">配置 →</span>
              </div>
            </div>
          </div>

          <InviteCard />

          <div class="farm-card rounded-lg p-4">
            <h4 class="mb-3 flex items-center gap-2 text-sm text-gray-900 font-semibold dark:text-gray-100">
              <span class="i-carbon-receipt text-base" />
              我的核销记录
            </h4>
            <div v-if="redemptionsLoading" class="py-5 text-center text-sm text-gray-400">
              加载中…
            </div>
            <div v-else-if="myRedemptions.length === 0" class="py-5 text-center text-sm text-gray-400">
              暂无记录
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="item in myRedemptions"
                :key="item.id"
                class="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs last:border-0"
                style="border-color: var(--surface-border);"
              >
                <span class="font-mono">{{ item.code }}</span>
                <span class="text-gray-500">{{ item.cardType === 'quota' ? '额度卡' : '加时卡' }} · {{ item.summary }}</span>
                <span class="text-gray-400">{{ new Date(item.at).toLocaleString('zh-CN', { hour12: false }) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 管理后台：用户 / 卡密 / 邀请 / 流水 / 日志 / 公告 / 邮件（仅超级管理员可见） -->
        <AdminPanel v-else-if="activeTab === 'admin-panel' && userStore.isSuperAdmin" />
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>

<style scoped>
.settings-workspace {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.settings-navigation {
  position: sticky;
  top: 12px;
  padding: 12px 8px;
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  background: var(--surface-1);
}
.settings-navigation-label {
  padding: 3px 12px 10px;
  color: var(--muted-text);
  font-size: 12px;
  letter-spacing: 0;
}
.settings-categories {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings-category {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  text-align: left;
  color: var(--muted-text);
  font-size: 13px;
  transition:
    background 150ms,
    color 150ms,
    border-color 150ms;
}
.settings-category > div {
  flex-shrink: 0;
  font-size: 18px;
}
.settings-category:hover {
  background: var(--surface-2);
  color: var(--theme-primary);
}
.settings-category[aria-pressed='true'] {
  border-color: #e0e9d4;
  background: #edf3e4;
  color: var(--theme-primary);
  font-weight: 650;
}
.settings-body {
  min-width: 0;
}
.settings-body :deep(.rounded-lg.bg-white),
.settings-body :deep(.rounded-xl.bg-white) {
  border-color: var(--surface-border);
  border-radius: 8px;
  background: var(--surface-1);
  box-shadow: var(--surface-shadow-soft);
}
@media (max-width: 1100px) {
  .settings-workspace {
    grid-template-columns: 160px minmax(0, 1fr);
    gap: 16px;
  }
}
@media (max-width: 767px) {
  .settings-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .settings-navigation {
    position: static;
    padding: 7px;
  }
  .settings-navigation-label {
    display: none;
  }
  .settings-categories {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px;
    overflow-x: auto;
  }
  .settings-category {
    flex: 1 0 auto;
    flex-shrink: 0;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    padding: 8px 10px;
    white-space: nowrap;
  }
}

/* ==================== 版本更新与回滚（当前 fork 独有） ==================== */
.system-update-card {
  container-type: inline-size;
}

.update-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.update-pane {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}

.update-pane--releases {
  padding-top: 18px;
  border-top: 1px solid var(--ui-border);
}

.update-pane__head {
  display: flex;
  min-height: 32px;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.update-pane__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.update-pane__title {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-600);
  line-height: 20px;
  white-space: nowrap;
}

.update-pane__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.update-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
  white-space: nowrap;
}

.update-state--ok {
  background: color-mix(in srgb, var(--ui-primary) 13%, transparent);
  color: var(--ui-primary);
}

.update-state--pending,
.update-state--busy {
  background: var(--ui-blue-soft);
  color: var(--ui-blue);
}

.update-state--warn {
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}

.update-state--muted {
  border: 1px solid var(--ui-border);
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
}

.update-facts {
  margin: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
}

.update-fact {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding: 9px 12px;
}

.update-fact + .update-fact {
  border-top: 1px solid var(--ui-border);
}

.update-fact dt {
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 20px;
}

.update-fact__value {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-500);
  line-height: 20px;
  white-space: nowrap;
}

.update-fact__muted {
  color: var(--ui-subtle);
}

.update-fact__sha {
  flex-shrink: 0;
  color: var(--ui-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  font-weight: var(--fw-600);
}

.update-fact__subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-notice {
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  font-size: 12px;
  line-height: 1.55;
}

.update-notice--muted {
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
}

.update-notice--warn {
  border-color: color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  background: var(--ui-warning-soft);
  color: var(--ui-ink);
}

.update-notice--info {
  border-color: color-mix(in srgb, var(--ui-blue) 30%, var(--ui-border));
  background: var(--ui-blue-soft);
  color: var(--ui-ink);
}

.update-block {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: var(--ui-surface-soft);
}

.update-block__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.update-block__count {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--ui-blue-soft);
  color: var(--ui-blue);
  font-size: 11px;
  line-height: 18px;
}

.update-commits {
  display: flex;
  max-height: 172px;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0 12px 10px;
  overflow-y: auto;
  list-style: none;
}

.update-commits__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
}

.update-commits__sha {
  flex-shrink: 0;
  color: var(--ui-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.update-commits__subject {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-commits__author {
  flex-shrink: 0;
  color: var(--ui-muted);
  font-size: 11px;
}

.update-job--running {
  border-color: color-mix(in srgb, var(--ui-blue) 35%, var(--ui-border));
}

.update-job--succeeded {
  border-color: color-mix(in srgb, var(--ui-primary) 35%, var(--ui-border));
}

.update-job--failed {
  border-color: color-mix(in srgb, var(--ui-danger) 40%, var(--ui-border));
}

.update-job__icon {
  flex-shrink: 0;
  font-size: 16px;
}

.update-job--running .update-job__icon {
  color: var(--ui-blue);
}

.update-job--succeeded .update-job__icon {
  color: var(--ui-primary);
}

.update-job--failed .update-job__icon {
  color: var(--ui-danger);
}

.update-job__error {
  padding: 0 12px 9px;
  color: var(--ui-danger);
  font-size: 12px;
  line-height: 1.5;
}

.update-job__log {
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-ink) 4%, transparent);
  color: var(--ui-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
}

.update-error {
  color: var(--ui-danger);
  font-size: 12px;
  line-height: 1.5;
}

@container (min-width: 860px) {
  .update-workspace {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
    gap: 0;
  }

  .update-pane--status {
    padding-right: 24px;
  }

  .update-pane--releases {
    padding-top: 0;
    padding-left: 24px;
    border-top: none;
    border-left: 1px solid var(--ui-border);
  }
}
</style>
