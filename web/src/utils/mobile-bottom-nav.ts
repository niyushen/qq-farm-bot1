/**
 * 手机端底部导航的条目解析：从侧栏菜单中挑出底栏要显示的几项。
 * 纯函数实现，不依赖 Vue 运行时，便于单元测试。
 */

/** 底栏条目的定义：[菜单名后缀, 短标签]。短标签为空时用菜单自身的名称。 */
export type MobileNavSpec = [name: string, shortLabel?: string]

/** 底栏默认展示的条目（概览 / 个人 / 活动 / 排行榜 / 设置）。 */
export const MOBILE_NAV_ITEMS: MobileNavSpec[] = [
  ['dashboard'],
  ['personal'],
  ['activity-center'],
  ['coin-rank', '排行榜'],
  ['Settings'],
]

/** 排行榜在农场与牧场空间的菜单名。 */
export const COIN_RANK_MENU_NAMES: readonly string[] = ['coin-rank', 'ranch-coin-rank']

/** 牧场空间的菜单名前缀。 */
export const RANCH_MENU_PREFIX = 'ranch-'

export interface MobileNavSourceItem {
  name: string
  path: string
  label: string
  icon: string
}

export interface MobileNavItem {
  path: string
  label: string
  icon: string
}

/** 把底栏条目名解析为当前空间下的完整菜单名。 */
export function resolveMenuName(name: string, inRanch: boolean): string {
  return inRanch ? `${RANCH_MENU_PREFIX}${name}` : name
}

/**
 * 从空间菜单中取出底栏条目。
 * - 找不到对应菜单名的条目会被丢弃（保持原有行为，避免出现死链）。
 * - `canViewCoinRank` 为 false 时，排行榜条目直接隐藏（与侧栏、路由守卫保持一致）。
 */
export function resolveMobileNavItems(
  menu: MobileNavSourceItem[],
  options: { inRanch?: boolean, specs?: MobileNavSpec[], canViewCoinRank?: boolean } = {},
): MobileNavItem[] {
  const inRanch = !!options.inRanch
  const specs = options.specs ?? MOBILE_NAV_ITEMS
  const canViewCoinRank = options.canViewCoinRank !== false

  const items: MobileNavItem[] = []
  for (const [name, shortLabel] of specs) {
    const menuName = resolveMenuName(name, inRanch)
    if (name === 'coin-rank' && !canViewCoinRank)
      continue
    const item = (menu || []).find(entry => entry.name === menuName)
    if (!item)
      continue
    items.push({
      path: `/${item.path}`,
      label: shortLabel || item.label,
      icon: item.icon,
    })
  }
  return items
}
