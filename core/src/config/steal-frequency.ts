/**
 * 偷菜频率（好友摘要校准周期）档位定义。
 *
 * 背景：偷菜巡查本身是成熟驱动的——它在好友作物成熟的那一刻醒来去偷。
 * 但「谁知道谁家什么时候熟」这件事依赖好友列表摘要，摘要必须定期拉一次才能刷新，
 * 这个刷新周期就是校准周期。周期越短，发现成熟越及时、偷到的越多，
 * 代价是拉取好友列表的请求变多（QQ 端按 GID 分批拉取，每批 35 个）。
 *
 * 三档：
 * - relaxed  省心：15 分钟校准一次，请求较少，可能错过部分成熟窗口
 * - standard 标准：8 分钟校准一次（默认），平衡发现及时度与请求量
 * - eager    勤快：3 分钟校准一次，发现最及时，请求量最大
 */

/** 三档档位标识。 */
export const STEAL_FREQUENCY_TIERS = ['relaxed', 'standard', 'eager'] as const;
export type StealFrequencyTier = typeof STEAL_FREQUENCY_TIERS[number];

/** 各档对应的摘要校准周期（毫秒）。 */
export const STEAL_FREQUENCY_CALIBRATION_MS: Record<StealFrequencyTier, number> = {
    relaxed: 15 * 60 * 1000,
    standard: 8 * 60 * 1000,
    eager: 3 * 60 * 1000,
};

/**
 * 默认档位：standard（8 分钟）。
 * 注意：早先版本的历史硬编码值是 15 分钟，本次统一收紧档位后默认行为随之变为 8 分钟。
 */
export const DEFAULT_STEAL_FREQUENCY_TIER: StealFrequencyTier = 'standard';

/**
 * 档位 → 校准周期。
 * 未知档位一律回落到默认档，避免旧配置或手改 JSON 造成校准周期变成 0（会变成死循环拉好友列表）。
 */
export function getStealCalibrationMs(tier: unknown): number {
    const key = String(tier || '').trim().toLowerCase() as StealFrequencyTier;
    if (!STEAL_FREQUENCY_TIERS.includes(key)) {
        return STEAL_FREQUENCY_CALIBRATION_MS[DEFAULT_STEAL_FREQUENCY_TIER];
    }
    return STEAL_FREQUENCY_CALIBRATION_MS[key];
}

/** 归一化档位值：非法值回落到默认档。 */
export function normalizeStealFrequencyTier(tier: unknown, fallback: StealFrequencyTier = DEFAULT_STEAL_FREQUENCY_TIER): StealFrequencyTier {
    const key = String(tier || '').trim().toLowerCase() as StealFrequencyTier;
    if (STEAL_FREQUENCY_TIERS.includes(key)) return key;
    return fallback;
}
