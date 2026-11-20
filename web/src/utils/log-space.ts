/**
 * 日志空间（牧场 / 农场）判定 —— 与服务端 core/src/utils/utils.ts 的 resolveLogSpace 保持一致。
 *
 * 服务端 appendLog 已给每条日志打上 space 字段，前端优先直接采信；
 * 仅在兼容旧服务端（无 space 字段）时才回退到三重判定：
 *   module=ranch → event 以 ranch_ 开头 → tag=牧场
 */

export const LOG_SPACE_RANCH = 'ranch'
export const LOG_SPACE_FARM = 'farm'

/** 判定日志条目所属空间 */
export function resolveEntrySpace(entry: any): 'ranch' | 'farm' {
  const declared = String(entry?.space || '')
  if (declared === LOG_SPACE_RANCH || declared === LOG_SPACE_FARM)
    return declared
  const meta = entry?.meta || {}
  if (String(meta.module || '') === LOG_SPACE_RANCH)
    return LOG_SPACE_RANCH
  if (String(meta.event || '').startsWith('ranch_'))
    return LOG_SPACE_RANCH
  if (String(entry?.tag || '') === '牧场')
    return LOG_SPACE_RANCH
  return LOG_SPACE_FARM
}

/** 是否为牧场日志 */
export function isRanchLog(entry: any) {
  return resolveEntrySpace(entry) === LOG_SPACE_RANCH
}
