import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/rolling-number.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} }
new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
const {
  alignRollingDigits,
  buildRollingDigits,
  buildRollingSlots,
  digitGlyph,
  easeOutCubic,
  formatRollingNumber,
  rollDigit,
  toFiniteNumber,
} = module.exports

test('formatRollingNumber 拆分符号、整数与小数部分', () => {
  assert.deepEqual(formatRollingNumber(1234), { sign: '', integer: '1,234', fraction: '' })
  assert.deepEqual(formatRollingNumber(-1234), { sign: '-', integer: '1,234', fraction: '' })
  assert.deepEqual(formatRollingNumber(1234, { sign: true }), { sign: '+', integer: '1,234', fraction: '' })
  // 正号只对正数生效，0 与负数不补 '+'
  assert.deepEqual(formatRollingNumber(0, { sign: true }), { sign: '', integer: '0', fraction: '' })
  assert.deepEqual(formatRollingNumber(-5, { sign: true }), { sign: '-', integer: '5', fraction: '' })
})

test('formatRollingNumber 支持小数位与千分位开关', () => {
  assert.deepEqual(formatRollingNumber(12.345, { decimals: 2 }), { sign: '', integer: '12', fraction: '35' })
  // 关闭千分位
  assert.deepEqual(formatRollingNumber(1234567, { group: false }), { sign: '', integer: '1234567', fraction: '' })
  // 小数位为 0 时不保留小数点
  assert.deepEqual(formatRollingNumber(12.7, { decimals: 0 }), { sign: '', integer: '13', fraction: '' })
})

test('formatRollingNumber 对非法值与越界小数位做兜底', () => {
  assert.equal(toFiniteNumber('abc'), 0)
  assert.equal(toFiniteNumber(undefined), 0)
  assert.equal(toFiniteNumber(Infinity), 0)
  assert.equal(toFiniteNumber('1234'), 1234)
  // decimals 钳制到 0~6，避免 toFixed 抛 RangeError
  assert.deepEqual(formatRollingNumber(1.5, { decimals: -3 }), { sign: '', integer: '2', fraction: '' })
  assert.deepEqual(formatRollingNumber(1.5, { decimals: 99 }), { sign: '', integer: '1', fraction: '500000' })
  assert.deepEqual(formatRollingNumber(1.5, { decimals: 2.9 }), { sign: '', integer: '1', fraction: '50' })
})

test('buildRollingDigits 按高位在前的顺序输出位序列', () => {
  assert.deepEqual(buildRollingDigits(1000), [1, 0, 0, 0])
  assert.deepEqual(buildRollingDigits(907), [9, 0, 7])
  assert.deepEqual(buildRollingDigits(0), [0])
  // 千分位分隔符不占位
  assert.deepEqual(buildRollingDigits(1234567), [1, 2, 3, 4, 5, 6, 7])
  // 小数位接在整数位之后
  assert.deepEqual(buildRollingDigits(12.34, { decimals: 2 }), [1, 2, 3, 4])
})

test('buildRollingSlots 在千分位处插入分隔符槽位', () => {
  const slots = buildRollingSlots(1234)
  // 1,234 -> 千分位分隔符落在第 1 位之后：digit, sep, digit, digit, digit
  assert.deepEqual(slots.map(s => s.type), ['digit', 'sep', 'digit', 'digit', 'digit'])
  assert.equal(slots[1].char, ',')
  // 数字槽位的 digitIndex 连续且与目标数组对应
  assert.deepEqual(slots.filter(s => s.type === 'digit').map(s => s.digitIndex), [0, 1, 2, 3])
  // 小数点插在整数与小数之间
  const withFraction = buildRollingSlots(12.34, { decimals: 2 })
  assert.deepEqual(withFraction.map(s => s.type), ['digit', 'digit', 'sep', 'digit', 'digit'])
  assert.equal(withFraction[2].char, '.')
  assert.equal(withFraction[3].isFraction, true)
  assert.equal(withFraction[0].isFraction, false)
})

test('alignRollingDigits 位数变化时按高位对齐', () => {
  // 位数变多：高位补 0
  assert.deepEqual(alignRollingDigits([1, 2], 4), [0, 0, 1, 2])
  // 位数变少：丢弃高位，保留末位
  assert.deepEqual(alignRollingDigits([1, 2, 3, 4], 2), [3, 4])
  // 长度不变：原样返回
  assert.deepEqual(alignRollingDigits([1, 2, 3], 3), [1, 2, 3])
  // 目标长度为 0
  assert.deepEqual(alignRollingDigits([1, 2], 0), [])
})

test('rollDigit 目标较小时向前多转一圈', () => {
  // 9 -> 0 走 9 -> 10，最终显示 0
  assert.equal(rollDigit(9, 0, 0), 9)
  assert.equal(rollDigit(9, 0, 1), 10)
  assert.equal(rollDigit(9, 0, 0.5), 9.5)
  // 目标大于起点时直接前进
  assert.equal(rollDigit(2, 7, 1), 7)
  assert.equal(rollDigit(2, 7, 0), 2)
})

test('digitGlyph 取模得到当前应显示的字形', () => {
  assert.equal(digitGlyph(0), 0)
  assert.equal(digitGlyph(9), 9)
  // 里程表回绕时 10 显示为 0
  assert.equal(digitGlyph(10), 0)
  assert.equal(digitGlyph(19), 9)
  assert.equal(digitGlyph(20), 0)
})

test('easeOutCubic 单调缓出且首尾归位', () => {
  assert.equal(easeOutCubic(0), 0)
  assert.equal(easeOutCubic(1), 1)
  // 越界输入被钳制
  assert.equal(easeOutCubic(-1), 0)
  assert.equal(easeOutCubic(2), 1)
  // 单调递增
  let previous = -1
  for (let i = 0; i <= 10; i++) {
    const value = easeOutCubic(i / 10)
    assert.ok(value >= previous, `easeOutCubic 在 t=${i / 10} 处非单调`)
    previous = value
  }
})
