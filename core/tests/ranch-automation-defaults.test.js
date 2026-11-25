'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RANCH_AUTOMATION_DEFAULTS,
  RANCH_SWITCH_KEYS,
} = require('../dist/config/ranch-automation');

/**
 * 这些牧场开关涉及消耗玩家资源（罐头时长道具、松果/便便换化肥），
 * 以及占用好友互动配额，默认必须关闭，由用户按需手动开启。
 */
const DEFAULT_OFF_KEYS = [
  ['ranch_fill_cans', '自动填充库存罐头'],
  ['ranch_feed_normal', '普通罐头喂养'],
  ['ranch_feed_organic', '有机罐头喂养'],
  ['ranch_stroke', '自动抚摸动物'],
  ['ranch_market_organic', '仓鼠集市自动兑换有机化肥'],
];

test('消耗资源的牧场开关默认全部关闭', () => {
  for (const [key] of DEFAULT_OFF_KEYS) {
    assert.equal(RANCH_AUTOMATION_DEFAULTS[key], false, `${key} 默认必须为 false`);
  }
});

test('五个关闭项仍属于可持久化的布尔开关', () => {
  // 必须在 RANCH_SWITCH_KEYS 内，否则前端开关无法保存/回读
  for (const [key] of DEFAULT_OFF_KEYS) {
    assert.ok(RANCH_SWITCH_KEYS.includes(key), `${key} 必须出现在 RANCH_SWITCH_KEYS 中`);
  }
});

test('其余牧场开关默认值不被改动', () => {
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_harvest, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_produce, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_clean, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_grass, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_grass_buy, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_task, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_share, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_daily_benefit, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_friend_steal, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_friend_produce, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_friend_clean, true);
  assert.equal(RANCH_AUTOMATION_DEFAULTS.ranch_friend_mosquito, true);
});
