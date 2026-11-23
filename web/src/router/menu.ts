export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
  meta?: {
    fullBleed?: boolean
    gameSpace?: 'ranch'
    ranchSection?: 'personal' | 'illustrated' | 'mall' | 'friends' | 'activity'
    /** 仅超级管理员可见/可访问，越权回首页 */
    superOnly?: boolean
  }
}

export const menuRoutes: MenuItem[] = [
  {
    path: '',
    name: 'dashboard',
    label: '概览',
    icon: 'i-carbon-dashboard',
    component: () => import('@/views/Dashboard.vue'),
  },
  {
    path: 'personal',
    name: 'personal',
    label: '个人',
    icon: 'i-carbon-sprout',
    component: () => import('@/views/Personal.vue'),
  },
  {
    path: 'illustrated',
    name: 'illustrated',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Illustrated.vue'),
  },
  {
    path: 'activity',
    name: 'activity-center',
    label: '活动',
    icon: 'i-carbon-events',
    component: () => import('@/views/ActivityCenter.vue'),
  },
  {
    path: 'friends',
    name: 'friends',
    label: '好友',
    icon: 'i-carbon-user-multiple',
    component: () => import('@/views/Friends.vue'),
  },
  {
    path: 'analytics',
    name: 'analytics',
    label: '分析',
    icon: 'i-carbon-chart-line',
    component: () => import('@/views/Analytics.vue'),
  },
  {
    path: 'coin-rank',
    name: 'coin-rank',
    label: '排行榜',
    icon: 'i-carbon-trophy',
    component: () => import('@/views/CoinRank.vue'),
  },
  {
    path: 'solar-calendar',
    name: 'solar-calendar',
    label: '节令日历',
    icon: 'i-carbon-calendar',
    component: () => import('@/views/SolarCalendar.vue'),
  },
  {
    path: 'game-mall',
    name: 'game-mall',
    label: '游戏商城',
    icon: 'i-carbon-shopping-cart',
    component: () => import('@/views/GameMall.vue'),
  },
  {
    path: 'settings',
    name: 'Settings',
    label: '设置',
    icon: 'i-carbon-settings',
    component: () => import('@/views/Settings.vue'),
  },
  {
    path: 'admin-panel',
    name: 'admin-panel',
    label: '管理后台',
    icon: 'i-carbon-user-admin',
    component: () => import('@/views/AdminPanel.vue'),
    meta: { superOnly: true },
  },
]

export const ranchMenuRoutes: MenuItem[] = [
  { path: 'ranch', name: 'ranch-dashboard', label: '概览', icon: 'i-carbon-dashboard', component: () => import('@/views/RanchOverview.vue'), meta: { gameSpace: 'ranch' } },
  { path: 'ranch/personal', name: 'ranch-personal', label: '个人', icon: 'i-carbon-sprout', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'personal' } },
  { path: 'ranch/illustrated', name: 'ranch-illustrated', label: '图鉴', icon: 'i-carbon-book', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'illustrated' } },
  { path: 'ranch/activity', name: 'ranch-activity-center', label: '活动', icon: 'i-carbon-gift', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'activity' } },
  { path: 'ranch/friends', name: 'ranch-friends', label: '好友', icon: 'i-carbon-user-multiple', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'friends' } },
  { path: 'ranch/strategy', name: 'ranch-strategy', label: '策略', icon: 'i-carbon-settings-adjust', component: () => import('@/views/RanchStrategy.vue'), meta: { gameSpace: 'ranch' } },
  { path: 'ranch/game-mall', name: 'ranch-game-mall', label: '游戏商城', icon: 'i-carbon-shopping-cart', component: () => import('@/views/Ranch.vue'), meta: { gameSpace: 'ranch', ranchSection: 'mall' } },
  // 牧场侧沿用农场侧的金币排行榜页面：统计口径是账号今日金币增加，与所在空间无关。
  { path: 'ranch/coin-rank', name: 'ranch-coin-rank', label: '排行榜', icon: 'i-carbon-trophy', component: () => import('@/views/CoinRank.vue'), meta: { gameSpace: 'ranch' } },
  { path: 'ranch/settings', name: 'ranch-Settings', label: '设置', icon: 'i-carbon-settings', component: () => import('@/views/Settings.vue'), meta: { gameSpace: 'ranch' } },
]

export const allMenuRoutes = [...menuRoutes, ...ranchMenuRoutes]
export function getSpaceMenu(inRanch: boolean) {
  return inRanch ? ranchMenuRoutes : menuRoutes
}
