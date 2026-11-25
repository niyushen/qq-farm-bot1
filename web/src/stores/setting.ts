import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { parseHourOfDay } from '@/utils/hour-of-day'
import { normalizeNotificationTemplates } from '@/utils/notification-template'
import { createRequestGuard } from '@/utils/request-guard'
import { DEFAULT_STEAL_FREQUENCY_TIER, normalizeStealFrequencyTier } from '@/utils/steal-frequency'

export interface MilkTeaSeedPolicy {
  targetSeedIds: number[]
  targetStock: number
  coinReserve: string
  coinDailyLimit: string
  ticketReserve: string
  ticketDailyLimit: string
}

export interface MilkTeaHirePolicy {
  durationId: number
  ticketDailyLimit: string
  ticketReserve: string
}

type RanchFeedStage = 'any' | 'longest' | 'to_production' | 'near_harvest'

export interface AutomationConfig {
  /** 牧场等后续新增的开关按 key 直接读写，字段随后端配置扩展。 */
  [key: string]: any
  ranch_harvest?: boolean
  ranch_produce?: boolean
  ranch_buy?: boolean
  ranch_upgrade?: boolean
  ranch_activate_shed?: boolean
  ranch_sell?: boolean
  ranch_market_organic?: boolean
  ranch_market_organic_poop?: boolean
  ranch_market_organic_pinecone?: boolean
  ranch_grass?: boolean
  ranch_grass_buy?: boolean
  ranch_grass_threshold_percent?: number
  ranch_fill_cans?: boolean
  /** 罐头使用时机（上游 PR #177）：普通与有机可分别设置。 */
  ranch_feed_normal?: boolean
  ranch_feed_normal_stage?: RanchFeedStage
  ranch_feed_organic?: boolean
  ranch_feed_organic_stage?: RanchFeedStage
  ranch_clean?: boolean
  ranch_stroke?: boolean
  ranch_friend_steal?: boolean
  ranch_friend_produce?: boolean
  ranch_friend_clean?: boolean
  ranch_friend_mosquito?: boolean
  ranch_task?: boolean
  ranch_illustrated?: boolean
  ranch_share?: boolean
  ranch_daily_benefit?: boolean
  ranch_check_minutes?: number
  ranch_strategy?: string
  ranch_bag_fallback?: string
  ranch_coop_animal?: number
  ranch_shed_animal?: number
  ranch_coop_cub_priority?: number[]
  ranch_shed_cub_priority?: number[]
  farm?: boolean
  farm_harvest_tiangong?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  friend_auto_accept?: boolean
  task?: boolean
  task_after_farm?: boolean
  sell?: boolean
  fertilizer?: string
  fertilizer_multi_season?: boolean
  fertilizer_2x2_ripen?: boolean
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  illustrated_auto_claim_rewards?: boolean
  illustrated_auto_buy_missing_seeds?: boolean
  illustrated_buy_skip_bag?: boolean
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
  friend_help_exp_limit?: boolean
  friend_help_protect_dog_ignore_exp_limit?: boolean
  friend_golden_bug?: boolean
  golden_bug_clear?: boolean
  fertilizer_gift?: boolean
  fertilizer_buy_organic?: boolean
  fertilizer_buy_normal?: boolean
  mall_coupon_gift_buy?: boolean
  mystery_shop_auto_buy?: boolean
  mystery_shop_allow_gold?: boolean
  mystery_shop_allow_coupon?: boolean
  mystery_shop_allow_gold_bean?: boolean
  mystery_shop_allow_diamond?: boolean
  mystery_shop_arrival_notify?: boolean
  mystery_shop_purchase_notify?: boolean
  skip_own_weed_bug?: boolean
  show_manual_fertilizer?: boolean
  // 宠物（自动喂狗粮）
  pet_feed_dog_food?: boolean
  pet_feed_dog_food_auto_buy?: boolean
  // 观星 / 星砂集市 / 节气
  star_passport_claim?: boolean
  star_solar_claim?: boolean
  star_solar_quiz_claim?: boolean
  star_record_claim?: boolean
  // 牧歌初启
  // 牧歌初启自动化（BUGDey 版；muge_personality_settle 由自动答题流程内部驱动）
  muge_task_claim?: boolean
  muge_celebration_claim?: boolean
  muge_friend_claim?: boolean
  muge_handbook_claim?: boolean
  muge_personality_settle?: boolean
  muge_auto_answer?: boolean
  // 青莓酒馆
  qingmei_seed_claim?: boolean
  qingmei_wine_brew?: boolean
  // 七夕
  qixi_dew_use?: boolean
  qixi_bridge_build?: boolean
  qixi_sachet_gift?: boolean
  qixi_friend_priority?: number[]
  // 雨落成诗
  rain_poem_bottle_buy?: boolean
  rain_poem_weather_collect?: boolean
  rain_poem_summon_use?: boolean
  rain_poem_prank_use?: boolean
  rain_poem_research_unlock?: boolean
  // 公益红花
  charity_flower_share_claim?: boolean
  charity_flower_donate?: boolean
  charity_flower_reward_claim?: boolean
  charity_flower_public_fund_claim?: boolean
  // 许愿签
  wish_sign_draw?: boolean
  wish_sign_choice?: number
  wish_sign_claim?: boolean
  // 分享奖励
  share_reward_share?: boolean
  share_reward_daily?: boolean
  share_reward_milestones?: boolean
  // 萌宠成长日记
  pet_diary_adopt?: boolean
  pet_diary_feed?: boolean
  pet_diary_draw?: boolean
  pet_diary_story_claim?: boolean
  pet_diary_seed_claim?: boolean
  pet_diary_solar_claim?: boolean
  pet_diary_treasure_open?: boolean
  pet_diary_compensation_claim?: boolean
  pet_diary_charm_equip?: boolean
  pet_diary_battle?: boolean
  // 奶茶店
  milk_tea_share?: boolean
  milk_tea_share_daily?: boolean
  milk_tea_share_rewards?: boolean
  milk_tea_fund_rewards?: boolean
  milk_tea_cashier?: boolean
  milk_tea_wages?: boolean
  milk_tea_upgrade?: boolean
  milk_tea_craft?: boolean
  milk_tea_boost?: boolean
  milk_tea_interact?: boolean
  milk_tea_interaction_type?: number
  milk_tea_hire?: boolean
  milk_tea_hire_duration?: number
  milk_tea_hire_talent?: number
  milk_tea_hire_primary_talent?: number
  milk_tea_hire_backup_talent?: number
  milk_tea_seed_buy?: boolean
  milk_tea_seed_buy_coin?: boolean
  milk_tea_seed_buy_exp?: boolean
  milk_tea_fertilizer_buy_normal?: boolean
  milk_tea_fertilizer_buy_organic?: boolean
  milk_tea_auto_open?: boolean
  milk_tea_work_interaction_type?: number
  milk_tea_seed_policy?: MilkTeaSeedPolicy
  milk_tea_hire_policy?: MilkTeaHirePolicy
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
  continueFarm?: boolean
}

/** 偷菜频率档位：决定好友摘要校准周期（relaxed 15 分钟 / standard 8 分钟 / eager 3 分钟）。 */
export type StealFrequencyTier = 'relaxed' | 'standard' | 'eager'

export interface PushChannelOption {
  label: string
  value: string
  docUrl: string
}

export const PUSH_CHANNEL_OPTIONS: PushChannelOption[] = [
  { label: 'Webhook(自定义接口)', value: 'webhook', docUrl: '' },
  { label: 'Qmsg 酱', value: 'qmsg', docUrl: 'https://qmsg.zendee.cn/' },
  { label: 'Server 酱', value: 'serverchan', docUrl: 'https://sct.ftqq.com/' },
  { label: 'Push Plus', value: 'pushplus', docUrl: 'https://www.pushplus.plus/' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip', docUrl: 'https://pushplus.hxtrip.com/' },
  { label: '钉钉', value: 'dingtalk', docUrl: 'https://open.dingtalk.com/document/orgapp/customize-robot-security-settings' },
  { label: '企业微信', value: 'wecom', docUrl: 'https://guole.fun/posts/626/' },
  { label: 'Bark', value: 'bark', docUrl: 'https://github.com/Finb/Bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp', docUrl: 'https://docs.go-cqhttp.org/api/' },
  { label: 'OneBot', value: 'onebot', docUrl: 'https://docs.go-cqhttp.org/api/' },
  { label: 'Atri', value: 'atri', docUrl: 'https://blog.tianli0.top/' },
  { label: 'PushDeer', value: 'pushdeer', docUrl: 'https://www.pushdeer.com/' },
  { label: 'iGot', value: 'igot', docUrl: 'https://push.hellyw.com/' },
  { label: 'Telegram', value: 'telegram', docUrl: 'https://core.telegram.org/bots' },
  { label: '飞书', value: 'feishu', docUrl: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973' },
  { label: 'IFTTT', value: 'ifttt', docUrl: 'https://ifttt.com/maker_webhooks' },
  { label: '企业微信群机器人', value: 'wecombot', docUrl: 'https://developer.work.weixin.qq.com/document/path/91770' },
  { label: 'Discord', value: 'discord', docUrl: 'https://discord.com/developers/docs/resources/webhook#execute-webhook' },
  { label: 'WxPusher', value: 'wxpusher', docUrl: 'https://wxpusher.zjiecode.com/docs/#/' },
  { label: 'MeoW', value: 'meow', docUrl: 'https://www.chuckfang.com/MeoW/api_doc.html' },
]

export interface OfflineChannelConfig {
  channel: string
  enabled: boolean
  endpoint: string
  token: string
  secret: string
}

export type PushChannelChange = Pick<OfflineChannelConfig, 'channel' | 'enabled'> & Partial<OfflineChannelConfig>

export interface OfflineConfig {
  notificationTypes?: {
    offline: boolean
    mysteryArrival: boolean
    mysteryPurchase: boolean
  }
  channel: string
  endpoint: string
  token: string
  secret: string
  channels: OfflineChannelConfig[]
  title: string
  msg: string
  offlineDeleteSec: number
  templates?: import('@/utils/notification-template').NotificationTemplates
  events?: Record<'account_offline' | 'friend_crop_forecast' | 'friend_crop_mature', string[]>
  smtpEnabled?: boolean
  barkEnabled?: boolean
  barkAccountKeys?: Record<string, string>
  barkLevels?: Record<import('@/utils/notification-template').NotificationEvent, string>
  barkTestKey?: string
  reloginUrlMode?: string
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPass?: string
  senderName?: string
  recipientEmail?: string
  emailContent?: string
  /** SMTP 渠道专用：使用管理员配置的全局邮件服务（免填 SMTP 账号密码） */
  useGlobalMailer?: boolean
}

export interface AutoCodeRefreshConfig {
  /** 当前 fork 语义：微信定时刷新重登（按账号保存） */
  enabled: boolean
  intervalMinutes: number
}

export interface GlobalMailerPublic {
  available: boolean
  senderName: string
}

export interface FriendMonitorConfig {
  enabled: boolean
  friendGids: number[]
  barkKeys: Record<string, string>
  intervalMinSec: number
  intervalMaxSec: number
  leadSeconds: number
  forecastEnabled: boolean
  matureEnabled: boolean
  protectFriends: boolean
}

export function createDefaultFriendMonitor(): FriendMonitorConfig {
  return { enabled: false, friendGids: [], barkKeys: {}, intervalMinSec: 180, intervalMaxSec: 300, leadSeconds: 120, forecastEnabled: true, matureEnabled: true, protectFriends: true }
}

const VALID_PUSH_CHANNELS = new Set(PUSH_CHANNEL_OPTIONS.map(item => item.value))

export function getPushChannelLabel(channel: string): string {
  const key = String(channel || '').trim().toLowerCase()
  return PUSH_CHANNEL_OPTIONS.find(item => item.value === key)?.label || key || '未知渠道'
}

export function getPushChannelDocUrl(channel: string): string {
  const key = String(channel || '').trim().toLowerCase()
  return PUSH_CHANNEL_OPTIONS.find(item => item.value === key)?.docUrl || ''
}

export function isPushChannelConfigured(input?: Partial<OfflineChannelConfig>): boolean {
  if (!input)
    return false
  const channel = String(input.channel || '').trim().toLowerCase()
  if (!VALID_PUSH_CHANNELS.has(channel))
    return false
  const endpoint = String(input.endpoint || '').trim()
  const token = String(input.token || '').trim()
  if (channel === 'webhook')
    return endpoint.length > 0
  if (channel === 'dingtalk')
    return endpoint.length > 0 || token.length > 0
  return token.length > 0
}

export function validateDingTalkWebhook(endpointInput: string): string {
  const endpoint = String(endpointInput || '').trim()
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

export function normalizeChannelEntry(raw: Partial<OfflineChannelConfig> | null | undefined): OfflineChannelConfig | null {
  if (!raw || typeof raw !== 'object')
    return null
  const channel = String(raw.channel || '').trim().toLowerCase()
  if (!VALID_PUSH_CHANNELS.has(channel))
    return null
  let endpoint = String(raw.endpoint || '').trim()
  let token = String(raw.token || '').trim()
  const secret = String(raw.secret || '').trim()

  if (channel === 'dingtalk') {
    if (!endpoint && token) {
      endpoint = /^https?:\/\//i.test(token)
        ? token
        : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`
    }
    token = ''
  }

  const configured = isPushChannelConfigured({ channel, endpoint, token })
  if (!configured && !endpoint && !token && !secret)
    return null

  return {
    channel,
    enabled: raw.enabled === true && configured,
    endpoint,
    token,
    secret,
  }
}

export function normalizeOfflineConfig(config?: Partial<OfflineConfig>): OfflineConfig {
  const defaults = createDefaultOfflineReminder()
  const rawChannel = String(config?.channel || 'webhook').trim().toLowerCase()
  // smtp 是本地 fork 扩展渠道，不进入上游的 pushoo 渠道集合，但主渠道值必须保留。
  let channel = rawChannel === 'smtp' ? 'smtp' : (VALID_PUSH_CHANNELS.has(rawChannel) ? rawChannel : 'webhook')
  let endpoint = String(config?.endpoint ?? '').trim()
  let token = String(config?.token ?? '').trim()
  let secret = String(config?.secret ?? '').trim()

  const hasExplicitChannels = Array.isArray(config?.channels)
  const channels: OfflineChannelConfig[] = []
  if (hasExplicitChannels) {
    const map = new Map<string, OfflineChannelConfig>()
    for (const item of config!.channels!) {
      const normalized = normalizeChannelEntry(item)
      if (!normalized)
        continue
      if (map.has(normalized.channel))
        map.delete(normalized.channel)
      map.set(normalized.channel, normalized)
    }
    channels.push(...map.values())
  }
  else {
    const migrated = normalizeChannelEntry({ channel, endpoint, token, secret, enabled: true })
    if (migrated && isPushChannelConfigured(migrated))
      channels.push(migrated)
  }

  const primary = channels.find(c => c.enabled)
  if (primary) {
    channel = primary.channel
    endpoint = primary.endpoint
    token = primary.token
    secret = primary.secret
  }
  else if (hasExplicitChannels) {
    channel = rawChannel === 'smtp' ? 'smtp' : 'webhook'
    endpoint = ''
    token = ''
    secret = ''
  }

  const parsedDeleteSec = Number.parseInt(String(config?.offlineDeleteSec ?? 0), 10)
  return {
    ...defaults,
    ...(config || {}),
    channel,
    endpoint,
    token,
    secret,
    channels,
    notificationTypes: { ...defaults.notificationTypes!, ...(config?.notificationTypes || {}) },
    templates: normalizeNotificationTemplates(config?.templates),
    events: { ...defaults.events, ...config?.events } as OfflineConfig['events'],
    barkAccountKeys: { ...config?.barkAccountKeys },
    barkLevels: { ...defaults.barkLevels, ...config?.barkLevels } as OfflineConfig['barkLevels'],
    title: typeof config?.title === 'string' ? config.title : '账号下线提醒',
    msg: typeof config?.msg === 'string' ? config.msg : '账号下线',
    offlineDeleteSec: Number.isFinite(parsedDeleteSec) && parsedDeleteSec >= 0 ? parsedDeleteSec : 0,
  }
}

export interface UIConfig {
  theme?: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedMultiLandReservationEnabled: boolean
  bagSeedLandTypes: Record<string, string[]>
  bagSeedFallbackStrategy: string
  /** 优先种植 2×2 作物：开启后选种时多格作物排在单格前面。 */
  prioritize2x2Crops: boolean
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  /** 偷菜频率档位：好友摘要校准周期档位。 */
  stealFrequencyTier: StealFrequencyTier
  automation: AutomationConfig
  /** 微信定时刷新重登（按账号保存） */
  autoCodeRefresh: AutoCodeRefreshConfig
  friendMonitor: FriendMonitorConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  /** 管理员是否配置好全局邮件服务（用户在通知设置里可勾选复用） */
  globalMailer: GlobalMailerPublic
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  emailClaimHour: number
  goldenBugKeepCount: number
  goldenBugRoundLimit: number
  autoAcceptFriendMinLevel: number
  autoAcceptRequireOwnLevel: boolean
  autoAcceptHarvestStealEnabled: boolean
  autoAcceptHarvestStealHarvest: number
  autoAcceptHarvestStealSteal: number
}

type SaveableSettingsKey
  = | 'plantingStrategy'
    | 'preferredSeedId'
    | 'bagSeedPriority'
    | 'bagSeedMultiLandReservationEnabled'
    | 'bagSeedLandTypes'
    | 'bagSeedFallbackStrategy'
    | 'prioritize2x2Crops'
    | 'intervals'
    | 'friendQuietHours'
    | 'stealFrequencyTier'
    | 'automation'
    | 'stealDelaySeconds'
    | 'plantOrderRandom'
    | 'plantDelaySeconds'
    | 'fertilizerBuyOrganicCount'
    | 'fertilizerBuyOrganicThresholdHours'
    | 'fertilizerBuyNormalCount'
    | 'fertilizerBuyNormalThresholdHours'
    | 'fertilizerBuyCheckIntervalMinutes'
    | 'emailClaimHour'
    | 'goldenBugKeepCount'
    | 'goldenBugRoundLimit'
    | 'autoAcceptFriendMinLevel'
    | 'autoAcceptRequireOwnLevel'
    | 'autoAcceptHarvestStealEnabled'
    | 'autoAcceptHarvestStealHarvest'
    | 'autoAcceptHarvestStealSteal'

export type SettingsSavePayload = Partial<Pick<SettingsState, SaveableSettingsKey>>

const SAVEABLE_SETTINGS_KEYS: SaveableSettingsKey[] = [
  'plantingStrategy',
  'preferredSeedId',
  'bagSeedPriority',
  'bagSeedMultiLandReservationEnabled',
  'bagSeedLandTypes',
  'bagSeedFallbackStrategy',
  'prioritize2x2Crops',
  'intervals',
  'friendQuietHours',
  'stealFrequencyTier',
  'automation',
  'stealDelaySeconds',
  'plantOrderRandom',
  'plantDelaySeconds',
  'fertilizerBuyOrganicCount',
  'fertilizerBuyOrganicThresholdHours',
  'fertilizerBuyNormalCount',
  'fertilizerBuyNormalThresholdHours',
  'fertilizerBuyCheckIntervalMinutes',
  'emailClaimHour',
  'goldenBugKeepCount',
  'goldenBugRoundLimit',
  'autoAcceptFriendMinLevel',
  'autoAcceptRequireOwnLevel',
  'autoAcceptHarvestStealEnabled',
  'autoAcceptHarvestStealHarvest',
  'autoAcceptHarvestStealSteal',
]

export function createDefaultOfflineReminder(): OfflineConfig {
  return {
    notificationTypes: { offline: true, mysteryArrival: true, mysteryPurchase: true },
    channels: [],
    templates: normalizeNotificationTemplates(),
    events: {
      account_offline: ['smtp', 'bark'],
      friend_crop_forecast: ['smtp', 'bark'],
      friend_crop_mature: ['smtp', 'bark'],
    },
    channel: 'webhook',
    smtpEnabled: false,
    barkEnabled: false,
    barkAccountKeys: {},
    barkLevels: {
      account_offline: 'timeSensitive',
      friend_crop_forecast: 'timeSensitive',
      friend_crop_mature: 'critical',
    },
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    secret: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
    useGlobalMailer: false,
    smtpHost: '',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    senderName: '',
    recipientEmail: '',
    emailContent: '',
  }
}

function normalizeOfflineReminder(input: Partial<OfflineConfig> | null | undefined): OfflineConfig {
  // 统一走上游渠道归一化，再补回本地 SMTP/事件模板字段。
  return normalizeOfflineConfig(input || {})
}

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    prioritize2x2Crops: true,
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
    stealFrequencyTier: DEFAULT_STEAL_FREQUENCY_TIER,
    automation: {},
    autoCodeRefresh: { enabled: false, intervalMinutes: 60 },
    friendMonitor: createDefaultFriendMonitor(),
    ui: {},
    offlineReminder: createDefaultOfflineReminder(),
    globalMailer: { available: false, senderName: '' },
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    emailClaimHour: 10,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null)
    return value
  return JSON.parse(JSON.stringify(value))
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const supportsPushChannels = ref<boolean | null>(null)
  const loading = ref(false)
  const loadedAccountId = ref('')
  let pendingRequests = 0
  let latestRequestedAccountId = ''
  // 只用「最新一次请求 + 最新请求的账号」判过期：切号时旧账号的回包必须丢弃。
  const fetchGuard = createRequestGuard({ accountId: () => latestRequestedAccountId })

  function beginRequest() {
    pendingRequests++
    loading.value = true
  }

  function endRequest() {
    pendingRequests = Math.max(0, pendingRequests - 1)
    loading.value = pendingRequests > 0
  }

  function applyFetchedSettings(data: any) {
    supportsPushChannels.value = Array.isArray(data.offlineReminder?.channels)
    const defaults = createDefaultSettings()
    settings.value = {
      plantingStrategy: data.strategy || defaults.plantingStrategy,
      preferredSeedId: data.preferredSeed || defaults.preferredSeedId,
      bagSeedPriority: cloneValue(data.bagSeedPriority ?? defaults.bagSeedPriority),
      bagSeedMultiLandReservationEnabled: data.bagSeedMultiLandReservationEnabled ?? defaults.bagSeedMultiLandReservationEnabled,
      bagSeedLandTypes: cloneValue(data.bagSeedLandTypes ?? defaults.bagSeedLandTypes),
      bagSeedFallbackStrategy: data.bagSeedFallbackStrategy ?? defaults.bagSeedFallbackStrategy,
      prioritize2x2Crops: !!data.prioritize2x2Crops,
      intervals: cloneValue(data.intervals || defaults.intervals),
      friendQuietHours: {
        ...defaults.friendQuietHours,
        ...(cloneValue(data.friendQuietHours) || {}),
      },
      stealFrequencyTier: normalizeStealFrequencyTier(data.stealFrequencyTier),
      automation: cloneValue(data.automation || defaults.automation),
      // 当前 fork 的 autoCodeRefresh 是微信定时刷新（enabled/intervalMinutes）；
      // 兼容旧快照的 offlineEnabled/offlineDelaySeconds，避免切号后字段错位。
      autoCodeRefresh: (() => {
        const raw = cloneValue(data.autoCodeRefresh) || {}
        return {
          enabled: typeof raw.enabled === 'boolean'
            ? raw.enabled
            : (raw.offlineEnabled === true),
          intervalMinutes: Number(raw.intervalMinutes)
            || Number(raw.offlineDelaySeconds)
            || defaults.autoCodeRefresh.intervalMinutes,
        }
      })(),
      friendMonitor: { ...defaults.friendMonitor, ...(cloneValue(data.friendMonitor) || {}) },
      ui: cloneValue(data.ui || defaults.ui),
      offlineReminder: normalizeOfflineReminder(cloneValue(data.offlineReminder)),
      globalMailer: {
        available: data.globalMailer?.available === true,
        senderName: String(data.globalMailer?.senderName || ''),
      },
      stealDelaySeconds: data.stealDelaySeconds ?? defaults.stealDelaySeconds,
      plantOrderRandom: data.plantOrderRandom ?? defaults.plantOrderRandom,
      plantDelaySeconds: data.plantDelaySeconds ?? defaults.plantDelaySeconds,
      fertilizerBuyOrganicCount: data.fertilizerBuyOrganicCount ?? defaults.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: data.fertilizerBuyOrganicThresholdHours ?? defaults.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: data.fertilizerBuyNormalCount ?? defaults.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: data.fertilizerBuyNormalThresholdHours ?? defaults.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: data.fertilizerBuyCheckIntervalMinutes ?? defaults.fertilizerBuyCheckIntervalMinutes,
      emailClaimHour: data.emailClaimHour ?? defaults.emailClaimHour,
      goldenBugKeepCount: data.goldenBugKeepCount ?? defaults.goldenBugKeepCount,
      goldenBugRoundLimit: data.goldenBugRoundLimit ?? defaults.goldenBugRoundLimit,
      autoAcceptFriendMinLevel: data.autoAcceptFriendMinLevel ?? defaults.autoAcceptFriendMinLevel,
      autoAcceptRequireOwnLevel: data.autoAcceptRequireOwnLevel ?? defaults.autoAcceptRequireOwnLevel,
      autoAcceptHarvestStealEnabled: data.autoAcceptHarvestStealEnabled ?? defaults.autoAcceptHarvestStealEnabled,
      autoAcceptHarvestStealHarvest: data.autoAcceptHarvestStealHarvest ?? defaults.autoAcceptHarvestStealHarvest,
      autoAcceptHarvestStealSteal: data.autoAcceptHarvestStealSteal ?? defaults.autoAcceptHarvestStealSteal,
    }
  }

  function applySavedSettings(payload: SettingsSavePayload, data: any) {
    const normalized = data && typeof data === 'object' ? data : {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key))
        (settings.value as any)[key] = cloneValue(payload[key])
      if (Object.prototype.hasOwnProperty.call(normalized, key))
        (settings.value as any)[key] = cloneValue(normalized[key])
    }

    if (normalized.strategy !== undefined)
      settings.value.plantingStrategy = normalized.strategy || 'max_exp'
    if (normalized.preferredSeed !== undefined)
      settings.value.preferredSeedId = normalized.preferredSeed || 0
  }

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return false
    const ticket = fetchGuard.next(accountId)
    latestRequestedAccountId = accountId
    loadedAccountId.value = ''
    beginRequest()
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (fetchGuard.isStale(ticket))
        return false
      if (data && data.ok && data.data) {
        applyFetchedSettings(data.data)
        loadedAccountId.value = accountId
        return true
      }
      return false
    }
    finally {
      endRequest()
    }
  }

  async function saveSettings(accountId: string, newSettings: SettingsSavePayload) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }

    const payload: SettingsSavePayload = {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(newSettings, key))
        (payload as any)[key] = cloneValue(newSettings[key])
    }

    // 后端对 emailClaimHour 有硬校验（非 0–23 整数直接抛 INVALID_CONFIG，整份快照都不生效）。
    // 设置页保存前已经拦过一次，这里兜住其它调用点：非法值就地剔除，别连累同一批的其它设置。
    const hasEmailClaimHour = Object.prototype.hasOwnProperty.call(payload, 'emailClaimHour')
    const emailClaimHour = parseHourOfDay((payload as any).emailClaimHour)
    if (hasEmailClaimHour) {
      if (emailClaimHour === null)
        delete (payload as any).emailClaimHour
      else
        (payload as any).emailClaimHour = emailClaimHour
    }

    if (Object.keys(payload).length === 0) {
      return {
        ok: false,
        error: hasEmailClaimHour ? '自动邮箱领取时间需为 0–23 的整数（时）' : '没有需要保存的设置',
      }
    }

    beginRequest()
    try {
      const { data } = await api.post('/api/settings/save', payload, {
        headers: { 'x-account-id': accountId },
        timeout: 15000,
      })
      if (!data?.ok) {
        if (data?.saved && (!latestRequestedAccountId || latestRequestedAccountId === accountId)) {
          loadedAccountId.value = accountId
          applySavedSettings(payload, data.data)
        }
        return {
          ok: false,
          saved: !!data?.saved,
          unconfirmed: !!data?.unconfirmed,
          data: data?.data,
          error: getApiErrorMessage(data, '保存失败'),
        }
      }

      if (!latestRequestedAccountId || latestRequestedAccountId === accountId) {
        loadedAccountId.value = accountId
        applySavedSettings(payload, data.data)
      }
      return { ok: true, data: data.data }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  async function saveOfflineConfig(config: Partial<OfflineConfig> & { enabled?: boolean }) {
    beginRequest()
    try {
      let payload = cloneValue(config)
      if (supportsPushChannels.value === false && config.enabled !== undefined) {
        const { channel = 'webhook', endpoint = '', token = '', secret = '' } = config
        payload = config.enabled ? { channel, endpoint, token, secret } : { channel: 'webhook', endpoint: '', token: '', secret: '' }
      }
      const { data } = await api.post('/api/settings/offline-reminder', payload)
      if (data && data.ok) {
        supportsPushChannels.value = Array.isArray(data.data?.channels)
        settings.value.offlineReminder = normalizeOfflineConfig(data.data)
        return { ok: true }
      }
      return { ok: false, error: '保存失败' }
    }
    catch (error: any) {
      return { ok: false, error: error?.response?.data?.error || error?.message || '保存失败' }
    }
    finally {
      endRequest()
    }
  }

  /** 与账号无关：拉取当前登录用户自己的设置（通知设置页未选账号时也能用） */
  async function fetchUserSettings() {
    beginRequest()
    try {
      const { data } = await api.get('/api/settings')
      if (data && data.ok && data.data)
        applyFetchedSettings(data.data)
    }
    catch {
      // 静默失败：保持已有状态
    }
    finally {
      endRequest()
    }
  }

  /** 刷新全局邮件服务可用状态（与账号无关） */
  async function fetchGlobalMailer() {
    try {
      const { data } = await api.get('/api/settings/mailer')
      if (data?.ok && data.data) {
        settings.value.globalMailer = {
          available: data.data.available === true,
          senderName: String(data.data.senderName || ''),
        }
      }
    }
    catch {
      // 静默失败：保持已有状态
    }
  }

  return { settings, loading, loadedAccountId, supportsPushChannels, fetchSettings, saveSettings, saveOfflineConfig, fetchUserSettings, fetchGlobalMailer }
})
