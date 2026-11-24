/**
 * 偷菜频率三档（好友摘要校准周期）。
 *
 * 与 `core/src/config/steal-frequency.ts` 的档位值一一对应：
 * 校准周期决定「多久刷新一次好友作物成熟时间」，偷菜巡查本身仍是成熟驱动
 * ——作物成熟的瞬间就会醒来去偷，不受这个周期影响。
 */
export type StealFrequencyTier = 'relaxed' | 'standard' | 'eager'

export interface StealFrequencyOption {
  value: StealFrequencyTier
  label: string
  /** 校准周期（分钟），用于面板上的描述文案。 */
  minutes: number
  desc: string
}

export const STEAL_FREQUENCY_OPTIONS: StealFrequencyOption[] = [
  {
    value: 'relaxed',
    label: '省心',
    minutes: 15,
    desc: '每 15 分钟刷新一次好友成熟时间，请求较少，可能错过部分成熟窗口',
  },
  {
    value: 'standard',
    label: '标准',
    minutes: 8,
    desc: '每 8 分钟刷新一次好友成熟时间，平衡发现及时度与请求量',
  },
  {
    value: 'eager',
    label: '勤快',
    minutes: 3,
    desc: '每 3 分钟刷新一次好友成熟时间，发现最及时，好友列表请求量最大',
  },
]

export const DEFAULT_STEAL_FREQUENCY_TIER: StealFrequencyTier = 'standard'

/** 归一化档位值：非法值回落到默认档。 */
export function normalizeStealFrequencyTier(value: unknown): StealFrequencyTier {
  const key = String(value || '').trim().toLowerCase()
  return (STEAL_FREQUENCY_OPTIONS.some(option => option.value === key))
    ? key as StealFrequencyTier
    : DEFAULT_STEAL_FREQUENCY_TIER
}

/** 取档位选项，找不到时回落到默认档。 */
export function getStealFrequencyOption(value: unknown): StealFrequencyOption {
  const tier = normalizeStealFrequencyTier(value)
  return STEAL_FREQUENCY_OPTIONS.find(option => option.value === tier)!
}
