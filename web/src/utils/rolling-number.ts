/**
 * 滚动数字格式化：把数值拆成「符号 + 整数位（含千分位）+ 小数位」，
 * 供逐位滚动的里程表组件消费。纯函数实现，不依赖 DOM，便于单元测试。
 */

export interface RollingNumberParts {
  /** 空串表示不显示符号；正数在 sign 开启时为 '+' */
  sign: '' | '+' | '-'
  /** 整数部分（可含千分位分隔符） */
  integer: string
  /** 小数部分（不含小数点） */
  fraction: string
}

export interface RollingNumberOptions {
  /** 小数位数，默认 0（金币为整数） */
  decimals?: number
  /** 是否对正数显示 '+' 前缀 */
  sign?: boolean
  /** 是否启用千分位分隔符 */
  group?: boolean
}

/** 渲染槽位：数字位或分隔符（千分位逗号 / 小数点） */
export type RollingSlot
  = | { type: 'digit', digitIndex: number, isFraction: boolean }
    | { type: 'sep', char: string }

export function toFiniteNumber(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * 拆解数值。负号永远保留；正号仅在 sign 开启时补上。
 * decimals 会做 0~6 的钳制，避免 toFixed 抛 RangeError。
 */
export function formatRollingNumber(value: unknown, options: RollingNumberOptions = {}): RollingNumberParts {
  const { sign = false, group = true } = options
  const decimals = Math.min(6, Math.max(0, Math.floor(Number(options.decimals ?? 0)) || 0))
  const num = toFiniteNumber(value)

  const fixed = Math.abs(num).toFixed(decimals)
  let [integer = '0', fraction = ''] = fixed.split('.')

  // 小数位为 0 时不保留小数点
  if (decimals === 0)
    fraction = ''

  if (group)
    integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  const signText: RollingNumberParts['sign'] = num < 0
    ? '-'
    : (sign && num > 0 ? '+' : '')

  return { sign: signText, integer, fraction }
}

/**
 * 渲染槽位序列：整数位按千分位插入分隔符槽位，小数点插在整数与小数之间。
 * 数字槽位通过 digitIndex 指向目标数字数组中的下标。
 */
export function buildRollingSlots(value: unknown, options: RollingNumberOptions = {}): RollingSlot[] {
  const parts = formatRollingNumber(value, options)
  const slots: RollingSlot[] = []
  let digitIndex = 0

  for (const ch of parts.integer) {
    if (ch >= '0' && ch <= '9') {
      slots.push({ type: 'digit', digitIndex: digitIndex++, isFraction: false })
    }
    else {
      slots.push({ type: 'sep', char: ch })
    }
  }

  if (parts.fraction) {
    slots.push({ type: 'sep', char: '.' })
    for (let i = 0; i < parts.fraction.length; i++)
      slots.push({ type: 'digit', digitIndex: digitIndex++, isFraction: true })
  }

  return slots
}

/**
 * 逐位滚动的目标位序：高位在前（与阅读顺序一致）。
 * 例：formatRollingNumber(1000) -> [1, 0, 0, 0]；1.25 -> [1, 2, 5]
 */
export function buildRollingDigits(value: unknown, options: RollingNumberOptions = {}): number[] {
  const parts = formatRollingNumber(value, options)
  const integerDigits = parts.integer.replace(/\D/g, '').split('').map(ch => Number(ch))
  const fractionDigits = parts.fraction ? parts.fraction.split('').map(ch => Number(ch)) : []
  return [...integerDigits, ...fractionDigits]
}

/**
 * 位数对齐：把当前显示的位数组对齐到目标长度。
 * - 位数变多：在高位补 0（新位从 0 滚入）。
 * - 位数变少：丢弃高位，保留末位（保证小数点一侧的位置不动）。
 */
export function alignRollingDigits(current: number[], targetLength: number): number[] {
  const length = Math.max(0, targetLength)
  if (current.length > length)
    return current.slice(current.length - length)
  const next = current.slice()
  while (next.length < length)
    next.unshift(0)
  return next
}

/**
 * 单个位从 from 滚到 to 的连续值：目标小于起点时按里程表惯例向前多转一整圈
 * （9 → 0 变成 9 → 10，最终显示 0），避免出现「倒着退」的观感。
 */
export function rollDigit(from: number, to: number, eased: number): number {
  const target = to < from ? to + 10 : to
  return from + (target - from) * eased
}

/**
 * 连续值对应的显示字形：超出 0~9 的部分取模，得到当前应当显示的数字。
 */
export function digitGlyph(value: number): number {
  return ((Math.round(value) % 10) + 10) % 10
}

/** 缓动：三次缓出，收尾自然 */
export function easeOutCubic(t: number): number {
  const ratio = Math.min(1, Math.max(0, t))
  return 1 - ((1 - ratio) ** 3)
}
