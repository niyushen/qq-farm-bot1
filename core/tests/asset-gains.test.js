const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-asset-gains-'));
process.env.FARM_DATA_DIR = dataDir;
const stats = require('../dist/services/stats');

const account = id => `asset-gains-${id}`;
const snapshot = (gold, exp, coupon, goldBean) => ({ gold, exp, coupon, goldBean });

test('session gains include goldBean, today gains track changes after baseline', () => {
  stats.initStatsWithPersistence(account(1), 1000, 500, 50, 20);
  const first = stats.getStats({}, snapshot(1100, 600, 60, 25), true, {});
  assert.equal(first.sessionGoldGained, 100);
  assert.equal(first.sessionExpGained, 100);
  assert.equal(first.sessionCouponGained, 10);
  assert.equal(first.sessionGoldBeanGained, 5);
  assert.equal(first.todayGoldGained, 0, 'first observation establishes today baseline');
  assert.equal(first.todayCouponGained, 0);
  assert.equal(first.todayGoldBeanGained, 0);

  const second = stats.getStats({}, snapshot(1150, 620, 70, 30), true, {});
  assert.equal(second.todayGoldGained, 50);
  assert.equal(second.todayCouponGained, 10);
  assert.equal(second.todayGoldBeanGained, 5);
  assert.equal(second.sessionGoldBeanGained, 10);
});

test('today baseline survives a same-day restart, session baseline resets', () => {
  const id = account(2);
  stats.initStatsWithPersistence(id, 1000, 500, 50, 20);
  stats.getStats({}, snapshot(1100, 600, 60, 25), true, {});
  stats.getStats({}, snapshot(1150, 620, 70, 30), true, {});
  stats.saveStats();

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats', `${id}.json`), 'utf8'));
  assert.equal(persisted.dailyBaseline.values.gold, 1100);
  assert.equal(persisted.dailyBaseline.values.goldBean, 25);

  stats.initStatsWithPersistence(id, 1150, 620, 70, 30);
  const afterRestart = stats.getStats({}, snapshot(1200, 640, 75, 33), true, {});
  assert.equal(afterRestart.todayGoldGained, 100, 'today delta uses persisted baseline');
  assert.equal(afterRestart.todayGoldBeanGained, 8);
  assert.equal(afterRestart.sessionGoldGained, 50, 'session delta starts from restart balance');
  assert.equal(afterRestart.sessionGoldBeanGained, 3);
});

test('offline status reuses last gains and never seeds baseline with zero balances', () => {
  stats.initStatsWithPersistence(account(3), 1000, 500, 50, 20);
  stats.getStats({}, snapshot(1200, 550, 55, 22), true, {});
  const offline = stats.getStats({}, snapshot(0, 0, 0, 0), false, {});
  assert.equal(offline.todayGoldGained, 0);
  assert.equal(offline.sessionGoldGained, 200);
  const onlineAgain = stats.getStats({}, snapshot(1250, 560, 58, 24), true, {});
  assert.equal(onlineAgain.todayGoldGained, 50, 'baseline was not polluted by offline zeros');
});

test('ranch currencies expose session and today gains keyed by item id', () => {
  stats.initStatsWithPersistence(account(4), 1000, 500, 50, 20);
  const currencies = [
    { id: 1007, count: '500' },
    { id: 1002, count: '60' },
    { id: 1005, count: '30' },
  ];
  const first = stats.getRanchAssetGains(currencies);
  assert.deepEqual(first['1007'], { sessionGained: 0, todayGained: 0 });

  const grown = [
    { id: 1007, count: '560' },
    { id: 1002, count: '70' },
    { id: 1005, count: '28' },
  ];
  const second = stats.getRanchAssetGains(grown);
  assert.deepEqual(second['1007'], { sessionGained: 60, todayGained: 60 });
  assert.deepEqual(second['1002'], { sessionGained: 10, todayGained: 10 });
  assert.deepEqual(second['1005'], { sessionGained: -2, todayGained: -2 });
});
