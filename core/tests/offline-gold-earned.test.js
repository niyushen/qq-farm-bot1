const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-offline-earned-'));
process.env.FARM_DATA_DIR = dataDir;
const stats = require('../dist/services/stats');

const account = id => `offline-earned-${id}`;
const snapshot = gold => ({ gold, exp: 100, coupon: 0, goldBean: 0 });
const savedPath = id => path.join(dataDir, 'stats', `${id}.json`);

test('离线期间的正向收入在重连后补记入今日增加', () => {
    const id = account(1);
    stats.initStatsWithPersistence(id, 1000, 100);
    stats.getStats({}, snapshot(1000), true, {});
    stats.getStats({}, snapshot(1200), true, {}); // 在线赚 +200
    stats.saveStats(); // 落盘：dailyGoldEarned=200, lastObservedGold=1200

    const persisted = JSON.parse(fs.readFileSync(savedPath(id), 'utf8'));
    assert.equal(persisted.dailyGoldEarned.value, 200);
    assert.equal(persisted.lastObservedGold, 1200, '须持久化上次观测余额');

    // 模拟离线：账号余额从 1200 涨到 1350（离线赚 +150），重连登录
    stats.initStatsWithPersistence(id, 1350, 100);
    const afterReconnect = stats.getStats({}, snapshot(1350), true, {});
    assert.equal(afterReconnect.todayGoldEarned, 350, '200 在线 + 150 离线');
    assert.equal(afterReconnect.todayGoldGained, 350, '净值口径同样覆盖离线涨幅');
});

test('离线期间的花费仍不冲减今日增加', () => {
    const id = account(2);
    stats.initStatsWithPersistence(id, 1000, 100);
    stats.getStats({}, snapshot(1000), true, {});
    stats.getStats({}, snapshot(1200), true, {}); // +200
    stats.saveStats(); // lastObservedGold=1200

    // 离线花掉 200，余额回落到 1000，重连
    stats.initStatsWithPersistence(id, 1000, 100);
    const afterReconnect = stats.getStats({}, snapshot(1000), true, {});
    assert.equal(afterReconnect.todayGoldEarned, 200, '离线花费不扣减已计收入');
    assert.equal(afterReconnect.todayGoldGained, 0, '净值口径反映花费后的回落');
});

test('离线先花后赚按净增加计入，不重复计数', () => {
    const id = account(3);
    stats.initStatsWithPersistence(id, 1000, 100);
    stats.getStats({}, snapshot(1000), true, {});
    stats.getStats({}, snapshot(1300), true, {}); // +300
    stats.saveStats(); // lastObservedGold=1300, earned=300

    // 离线期间花到 1100 又赚回 1400（净 +100），重连仅能观测到首尾
    stats.initStatsWithPersistence(id, 1400, 100);
    const afterReconnect = stats.getStats({}, snapshot(1400), true, {});
    assert.equal(afterReconnect.todayGoldEarned, 400, '300 + 净增100，中间过程不可观测');
});

test('旧存档缺少 lastObservedGold 时向后兼容', () => {
    const id = account(4);
    stats.initStatsWithPersistence(id, 1000, 100);
    stats.getStats({}, snapshot(1000), true, {});
    stats.getStats({}, snapshot(1100), true, {}); // +100
    stats.saveStats();

    // 手工移除 lastObservedGold 模拟旧版本存档
    const data = JSON.parse(fs.readFileSync(savedPath(id), 'utf8'));
    delete data.lastObservedGold;
    fs.writeFileSync(savedPath(id), JSON.stringify(data), 'utf8');

    stats.initStatsWithPersistence(id, 1250, 100);
    const afterReconnect = stats.getStats({}, snapshot(1250), true, {});
    assert.equal(afterReconnect.todayGoldEarned, 100, '旧存档不补记离线收入，仅保留已累计值');
});
