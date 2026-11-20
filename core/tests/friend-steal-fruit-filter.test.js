'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeFriendLands,
  getFruitTypeByPlantId,
  isTargetFruit,
} = require('../dist/services/friend/visit-strategy');
const { getPlantById } = require('../dist/config/gameConfig');

// 真实配置中的植物 ID（已全量核对 fruit.id → Illustrated.param 映射）
const PLANT = {
  normal: 2020002,      // 白萝卜 → 普通果实，seed_id=29999
  activity: 1029001,    // 哈哈小南瓜 → 活动果实
  golden: 1120112,      // 黄金·风信子 → 黄金果实
  decoration: 1028001,  // 哈哈南瓜塔 → 装扮果实
};

function land(id, plantId) {
  return {
    id,
    unlocked: true,
    plant: {
      id: plantId,
      stealable: true,
      phases: [{ phase: 6, begin_time: 0 }], // 6 = PlantPhase.MATURE
    },
  };
}

const ALL_LANDS = [
  land(1, PLANT.normal),
  land(2, PLANT.activity),
  land(3, PLANT.golden),
  land(4, PLANT.decoration),
];

test('图鉴类别按 fruit.id 正确识别四类果实', () => {
  assert.equal(getFruitTypeByPlantId(PLANT.normal), '普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.activity), '活动果实');
  assert.equal(getFruitTypeByPlantId(PLANT.golden), '黄金果实');
  assert.equal(getFruitTypeByPlantId(PLANT.decoration), '装扮果实');
  assert.equal(getFruitTypeByPlantId(99999999), '', '未知植物返回空类别');
});

test('isTargetFruit 表驱动：两关全偷，单开只偷对应类，双开取并集', () => {
  const cases = [
    // fruitType, activityOnly, goldenOnly, expected
    ['普通果实', false, false, true],
    ['活动果实', false, false, true],
    ['黄金果实', false, false, true],
    ['装扮果实', false, false, true],
    ['', false, false, true],

    ['普通果实', true, false, false],
    ['活动果实', true, false, true],
    ['黄金果实', true, false, false],
    ['装扮果实', true, false, false],
    ['', true, false, false],

    ['普通果实', false, true, false],
    ['活动果实', false, true, false],
    ['黄金果实', false, true, true],
    ['装扮果实', false, true, false],
    ['', false, true, false],

    ['普通果实', true, true, false],
    ['活动果实', true, true, true],
    ['黄金果实', true, true, true],
    ['装扮果实', true, true, false],
    ['', true, true, false],
  ];
  for (const [type, activityOnly, goldenOnly, expected] of cases) {
    assert.equal(
      isTargetFruit(type, activityOnly, goldenOnly),
      expected,
      `type=${type} activityOnly=${activityOnly} goldenOnly=${goldenOnly}`,
    );
  }
});

test('不传过滤选项时保持原行为（黄金虫等服务不受影响）', () => {
  const result = analyzeFriendLands(ALL_LANDS, 999, 'f');
  assert.deepEqual(result.stealable, [1, 2, 3, 4]);
  assert.equal(result.stealableInfo.every(info => !('fruitType' in info)), false,
    'stealableInfo 始终附带 fruitType 字段');
});

test('只偷活动果实：普通/黄金/装扮均被跳过', () => {
  const result = analyzeFriendLands(ALL_LANDS, 999, 'f', { stealActivityOnly: true });
  assert.deepEqual(result.stealable, [2]);
  assert.deepEqual(result.stealableInfo.map(info => info.fruitType), ['活动果实']);
});

test('只偷黄金果实：仅黄金果实保留', () => {
  const result = analyzeFriendLands(ALL_LANDS, 999, 'f', { stealGoldenOnly: true });
  assert.deepEqual(result.stealable, [3]);
  assert.deepEqual(result.stealableInfo.map(info => info.fruitType), ['黄金果实']);
});

test('两个开关同时开启：取并集，普通与装扮果实仍被跳过', () => {
  const result = analyzeFriendLands(ALL_LANDS, 999, 'f', {
    stealActivityOnly: true,
    stealGoldenOnly: true,
  });
  assert.deepEqual(result.stealable, [2, 3]);
  assert.deepEqual(result.stealableInfo.map(info => info.fruitType), ['活动果实', '黄金果实']);
});

test('与蔬菜黑名单叠加：黑名单先过滤普通果实，类别过滤再生效', () => {
  // 活动/黄金果实植物的 seed_id 均为 null（已核对全量配置），黑名单只作用于普通果实
  const normalSeedId = getPlantById(PLANT.normal).seed_id;
  assert.ok(normalSeedId > 0);

  const result = analyzeFriendLands(ALL_LANDS, 999, 'f', {
    plantBlacklist: [normalSeedId],
    stealActivityOnly: true,
  });
  assert.deepEqual(result.stealable, [2], '普通果实同时被黑名单和类别过滤，结果不变');

  // 关闭类别过滤时，黑名单仍独立生效
  const blacklistOnly = analyzeFriendLands(ALL_LANDS, 999, 'f', {
    plantBlacklist: [normalSeedId],
  });
  assert.deepEqual(blacklistOnly.stealable, [2, 3, 4]);
});

test('严格跳过：过滤后无可偷目标时 stealable 为空，不影响其他互动类别', () => {
  const result = analyzeFriendLands([land(1, PLANT.normal)], 999, 'f', {
    stealGoldenOnly: true,
  });
  assert.deepEqual(result.stealable, []);
  assert.deepEqual(result.stealableInfo, []);
  assert.ok(Array.isArray(result.needWater));
  assert.ok(Array.isArray(result.canPutGoldenBug));
});
