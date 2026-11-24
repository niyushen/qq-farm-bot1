import type { RanchAutomationConfig } from '../config/ranch-automation';
export {};
export type PlantingStrategy =
  | 'preferred'
  | 'level'
  | 'max_exp'
  | 'max_fert_exp'
  | 'max_profit'
  | 'max_fert_profit'
  | 'bag_priority';

export type BagSeedFallbackStrategy = Exclude<PlantingStrategy, 'bag_priority'>;

export type FertilizerMode = 'both' | 'normal' | 'organic' | 'smart' | 'none' | 'normal_ripen' | 'organic_ripen';

export type FertilizerLandType = 'blue-crystal' | 'purple-gold' | 'gold' | 'black' | 'red' | 'normal';

export interface AutomationConfig extends RanchAutomationConfig {
  farm: boolean;
  farm_harvest_tiangong: boolean;
  farm_push: boolean;
  land_upgrade: boolean;
  friend: boolean;
  friend_auto_accept: boolean;
  friend_help_exp_limit: boolean;
  friend_steal: boolean;
  friend_steal_activity_only: boolean;
  friend_steal_golden_only: boolean;
  friend_help: boolean;
  friend_bad: boolean;
  friend_golden_bug: boolean;
  golden_bug_clear: boolean;
  friend_help_protect_dog_ignore_exp_limit: boolean;
  task: boolean;
  fertilizer_gift: boolean;
  fertilizer_buy_organic: boolean;
  fertilizer_buy_normal: boolean;
  mystery_shop_auto_buy: boolean;
  mystery_shop_allow_gold: boolean;
  mystery_shop_allow_coupon: boolean;
  mystery_shop_allow_gold_bean: boolean;
  mystery_shop_allow_diamond: boolean;
  mystery_shop_arrival_notify: boolean;
  mystery_shop_purchase_notify: boolean;
  sell: boolean;
  fertilizer: FertilizerMode;
  fertilizer_multi_season: boolean;
  fertilizer_land_types: FertilizerLandType[];
  fertilizer_smart_seconds: number;
  skip_own_weed_bug: boolean;
  show_manual_fertilizer: boolean;
}

export interface AutoCodeRefreshConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface IntervalConfig {
  farm: number;
  farmMin: number;
  farmMax: number;
  friendMin: number;
  friendMax: number;
  helpMin: number;
  helpMax: number;
  stealMin: number;
  stealMax: number;
  [key: string]: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  continueFarm: boolean;
}

/** 宠物资本模式：成熟前 leadSeconds 秒自动派出守护宠物，收获 5 秒后召回。 */
export interface CapitalModeConfig {
  enabled: boolean;
  dogId: number;
  leadSeconds: number;
}

export interface AccountConfig {
  automation: AutomationConfig;
  plantingStrategy: PlantingStrategy;
  preferredSeedId: number;
  /** 宠物资本模式：按作物成熟时间自动派出守护宠物。 */
  capitalMode: CapitalModeConfig;
  /** 微信定时刷新重登（按账号保存）：定时换新 Code + 被踢/断线自动重登 */
  autoCodeRefresh: AutoCodeRefreshConfig;
  intervals: IntervalConfig;
  friendQuietHours: QuietHoursConfig;
  knownFriendGids: number[];
  knownFriendGidSyncCooldownSec: number;
  friendsListCacheTtlSec: number;
  friendBlacklist: number[];
  ranchFriendBlacklist: number[];
  plantBlacklist: number[];
  stealDelaySeconds: number;
  plantOrderRandom: boolean;
  plantDelaySeconds: number;
  /** 黄金虫保留数量（背包中不出）。 */
  goldenBugKeepCount: number;
  /** 黄金虫单轮投放上限（1-100）。 */
  goldenBugRoundLimit: number;
  fertilizerBuyOrganicCount: number;
  fertilizerBuyOrganicThresholdHours: number;
  fertilizerBuyNormalCount: number;
  fertilizerBuyNormalThresholdHours: number;
  fertilizerBuyCheckIntervalMinutes: number;
  /** 每天检查邮箱奖励的时间（0-23 点，默认 10 点）；到点后每天只触发一次。 */
  emailClaimHour: number;
  bagSeedPriority: number[];
  /** 是否为明确排在前面的多格背包种子保留尚未连成布局的空地。 */
  bagSeedMultiLandReservationEnabled: boolean;
  /** seedId -> 允许种植的土地类型。缺 key 视为不限制。 */
  bagSeedLandTypes: Record<string, FertilizerLandType[]>;
  bagSeedFallbackStrategy: BagSeedFallbackStrategy;
  /** 优先种植 2×2 及以上的多格作物（多格作物排在单格作物之前）。 */
  prioritize2x2Crops: boolean;
  autoAcceptFriendMinLevel: number;
  autoAcceptRequireOwnLevel: boolean;
  autoAcceptHarvestStealEnabled: boolean;
  autoAcceptHarvestStealHarvest: number;
  autoAcceptHarvestStealSteal: number;
}

export interface OfflineReminder {
  channel: string;
  endpoint: string;
  token: string;
  secret: string;
  title: string;
  msg: string;
  offlineDeleteSec: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  senderName: string;
  recipientEmail: string;
  emailContent: string;
  /** SMTP 渠道专用：使用管理员配置的全局邮件服务（免填 SMTP 账号密码） */
  useGlobalMailer: boolean;
}

export interface UIConfig {
  theme: 'light' | 'dark';
}

export interface LoginSettings {
  wechatQrLogin: boolean;
  qqQrLogin: boolean;
  napCatEndpoint: string;
  napCatSignature: string;
}

export interface DeviceInfo {
  os: string;
  clientVersion: string;
  sysSoftware: string;
  network: string;
  memory: string;
  deviceId: string;
  userAgent: string;
}

export interface SystemConfig {
  serverUrl: string;
  clientVersion: string;
  clientVersionUpdatedAt?: number;
  wxClientVersion: string;
  wxClientVersionUpdatedAt?: number;
  platform: string;
  os: string;
  timeZone: string;
  deviceInfo: DeviceInfo;
}

export interface GlobalConfig {
  accountConfigs: Record<string, AccountConfig>;
  defaultAccountConfig: AccountConfig;
  ui: UIConfig;
  loginSettings: LoginSettings;
  offlineReminder: OfflineReminder;
  /** 按登录用户隔离的下线提醒配置（普通用户在「通知设置」里保存自己的配置） */
  userOfflineReminders: Record<string, OfflineReminder>;
  systemConfig: SystemConfig | null;
  /** 普通用户是否可见全部农场账号（默认关闭：仅可见自己添加的账号） */
  usersSeeAllAccounts: boolean;
  /** 排行榜数据可见范围：all=全员可见（默认），super_admin=仅超级管理员可见 */
  coinRankVisibility: 'all' | 'super_admin';
}
