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
  mandala: 1020116,     // 曼陀罗华 → 图鉴标普通果实，普通商城种子，按普通果实处理
  lingzhi: 1020202,     // 金边灵芝 → 图鉴标普通果实，普通商城种子，按普通果实处理
  guava: 1020529,       // 森野芭乐 → 活动限制作物（种子不可直接购买）
  rare: 1020224,        // 昙花 → 稀有珍品（种子不可直接购买）
  feed: 1020040,        // 牧草 → 普通饲料作物（种子在牧场商城在售）
  redPacket: 1021542,   // 新春红包 → 种子有 sells 价但不在商城，其它途径获取
  fortune: 1020329,     // 发财红包 → 同上
  pumpkin: 2029998,     // 哈哈南瓜 → 种子不在商城
  normalShop: 1020002,  // 白萝卜（商城种子变体 seed=20002）
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

test('活动限制作物与稀有珍品（种子不可直接购买）按活动果实处理', () => {
  assert.equal(getFruitTypeByPlantId(PLANT.guava), '活动果实');
  assert.equal(getFruitTypeByPlantId(PLANT.rare), '活动果实', '种子不可直接购买的稀有珍品按活动果实处理');
});

test('其它途径获取的种子一律按活动果实处理（红包/哈哈南瓜）', () => {
  assert.equal(getFruitTypeByPlantId(PLANT.redPacket), '活动果实', '有 sells 价但不在商城出售的种子仍属其它途径');
  assert.equal(getFruitTypeByPlantId(PLANT.fortune), '活动果实');
  assert.equal(getFruitTypeByPlantId(PLANT.pumpkin), '活动果实');
});

test('同一果实存在商城在售种子的变体时按普通果实处理', () => {
  assert.equal(getFruitTypeByPlantId(PLANT.normalShop), '普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.normal), '普通果实', '白萝卜另一变体 seed=29999 虽不在商城，但同果实 seed=20002 在售');
});

test('普通作物、饲料作物与商城作物仍为普通果实，黄金/装扮果实不被并入活动果实', () => {
  assert.equal(getFruitTypeByPlantId(PLANT.normal), '普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.feed), '普通果实', '牧草种子在牧场商城有售，仍属普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.mandala), '普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.lingzhi), '普通果实');
  assert.equal(getFruitTypeByPlantId(PLANT.golden), '黄金果实');
  assert.equal(getFruitTypeByPlantId(PLANT.decoration), '装扮果实');
});

test('只偷活动果实：稀有珍品与活动限制作物一并偷取，饲料/普通作物跳过', () => {
  const lands = [
    land(1, PLANT.rare),
    land(2, PLANT.guava),
    land(3, PLANT.normal),
    land(4, PLANT.feed),
    land(5, PLANT.golden),
  ];
  const result = analyzeFriendLands(lands, 999, 'f', { stealActivityOnly: true });
  assert.deepEqual(result.stealable, [1, 2]);

  // 只偷黄金果实时仍只保留黄金果实，不误偷这些活动果实
  const goldenOnly = analyzeFriendLands(lands, 999, 'f', { stealGoldenOnly: true });
  assert.deepEqual(goldenOnly.stealable, [5]);
});

test('只偷活动果实：曼陀罗华/金边灵芝按普通果实跳过，森野芭乐保留', () => {
  const lands = [
    land(1, PLANT.mandala),
    land(2, PLANT.lingzhi),
    land(3, PLANT.guava),
    land(4, PLANT.normal),
  ];
  const result = analyzeFriendLands(lands, 999, 'f', { stealActivityOnly: true });
  assert.deepEqual(result.stealable, [3]);
  assert.deepEqual(result.stealableInfo.map(info => info.fruitType), ['活动果实']);

  // 只偷黄金果实时不误偷这些果实
  const goldenOnly = analyzeFriendLands(lands, 999, 'f', { stealGoldenOnly: true });
  assert.deepEqual(goldenOnly.stealable, []);

  // 开关关闭时保持全偷
  const all = analyzeFriendLands(lands, 999, 'f');
  assert.deepEqual(all.stealable, [1, 2, 3, 4]);
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
