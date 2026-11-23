import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/mobile-bottom-nav.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
const {
  COIN_RANK_MENU_NAMES,
  MOBILE_NAV_ITEMS,
  resolveMenuName,
  resolveMobileNavItems,
} = module.exports

const farmMenu = [
  { name: 'dashboard', path: '', label: '概览', icon: 'i-carbon-dashboard' },
  { name: 'personal', path: 'personal', label: '个人', icon: 'i-carbon-sprout' },
  { name: 'activity-center', path: 'activity', label: '活动', icon: 'i-carbon-events' },
  { name: 'coin-rank', path: 'coin-rank', label: '排行榜', icon: 'i-carbon-trophy' },
  { name: 'game-mall', path: 'game-mall', label: '游戏商城', icon: 'i-carbon-shopping-cart' },
  { name: 'Settings', path: 'settings', label: '设置', icon: 'i-carbon-settings' },
]

const ranchMenu = [
  { name: 'ranch-dashboard', path: 'ranch', label: '概览', icon: 'i-carbon-dashboard' },
  { name: 'ranch-personal', path: 'ranch/personal', label: '个人', icon: 'i-carbon-sprout' },
  { name: 'ranch-activity-center', path: 'ranch/activity', label: '活动', icon: 'i-carbon-gift' },
  { name: 'ranch-coin-rank', path: 'ranch/coin-rank', label: '排行榜', icon: 'i-carbon-trophy' },
  { name: 'ranch-game-mall', path: 'ranch/game-mall', label: '游戏商城', icon: 'i-carbon-shopping-cart' },
  { name: 'ranch-Settings', path: 'ranch/settings', label: '设置', icon: 'i-carbon-settings' },
]

test('默认底栏条目为概览 / 个人 / 活动 / 排行榜 / 设置，不含商城', () => {
  const names = MOBILE_NAV_ITEMS.map(([name]) => name)
  assert.deepEqual(names, ['dashboard', 'personal', 'activity-center', 'coin-rank', 'Settings'])
  assert.ok(!names.includes('game-mall'), '底栏不应再出现商城入口')
})

test('农场空间解析出五项，第四项为排行榜', () => {
  const items = resolveMobileNavItems(farmMenu, { inRanch: false })
  assert.equal(items.length, 5)
  assert.deepEqual(items.map(item => item.label), ['概览', '个人', '活动', '排行榜', '设置'])
  assert.equal(items[3].path, '/coin-rank')
  assert.equal(items[3].icon, 'i-carbon-trophy')
  // 商城已从底栏移除
  assert.ok(!items.some(item => item.path === '/game-mall'))
})

test('牧场空间解析出五项，第四项指向牧场排行榜', () => {
  const items = resolveMobileNavItems(ranchMenu, { inRanch: true })
  assert.equal(items.length, 5)
  assert.deepEqual(items.map(item => item.label), ['概览', '个人', '活动', '排行榜', '设置'])
  assert.equal(items[3].path, '/ranch/coin-rank')
  assert.ok(!items.some(item => item.path === '/ranch/game-mall'))
})

test('排行榜不可见时整项隐藏，其余条目保持顺序', () => {
  const items = resolveMobileNavItems(farmMenu, { inRanch: false, canViewCoinRank: false })
  assert.equal(items.length, 4)
  assert.deepEqual(items.map(item => item.label), ['概览', '个人', '活动', '设置'])
  assert.ok(!items.some(item => item.path === '/coin-rank'))
})

test('菜单缺少对应条目时跳过，不产生死链', () => {
  // 牧场菜单里没有排行榜（后端/菜单未同步的情况）
  const withoutRank = ranchMenu.filter(item => item.name !== 'ranch-coin-rank')
  const items = resolveMobileNavItems(withoutRank, { inRanch: true })
  assert.equal(items.length, 4)
  assert.ok(!items.some(item => item.path.includes('coin-rank')))
})

test('自定义短标签优先于菜单名称', () => {
  const items = resolveMobileNavItems(farmMenu, {
    specs: [['coin-rank', '榜单'], ['dashboard']],
  })
  assert.deepEqual(items.map(item => item.label), ['榜单', '概览'])
})

test('resolveMenuName 按空间补 ranch- 前缀', () => {
  assert.equal(resolveMenuName('coin-rank', false), 'coin-rank')
  assert.equal(resolveMenuName('coin-rank', true), 'ranch-coin-rank')
})

test('排行榜菜单名覆盖农场与牧场两套', () => {
  assert.deepEqual([...COIN_RANK_MENU_NAMES], ['coin-rank', 'ranch-coin-rank'])
})
