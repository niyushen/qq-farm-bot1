const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-today-earned-'));
process.env.FARM_DATA_DIR = dataDir;
const stats = require('../dist/services/stats');

const account = id => `today-earned-${id}`;
const snapshot = (gold, exp = 100, coupon = 0, goldBean = 0) => ({ gold, exp, coupon, goldBean });

test('todayGoldEarned accumulates only positive gold changes, ignoring upgrade spend', () => {
    stats.initStatsWithPersistence(account(1), 1000, 100);
    // 首次观测：建立今日净值基线，收入为 0
    const first = stats.getStats({}, snapshot(1000), true, {});
    assert.equal(first.todayGoldEarned, 0);

    // +200 收入
    stats.getStats({}, snapshot(1200), true, {});
    // -150 升级花费（金币下降）→ 不应冲减今日收入
    const afterSpend = stats.getStats({}, snapshot(1050), true, {});
    assert.equal(afterSpend.todayGoldEarned, 200, 'spend must not reduce today earned');
    // 净值口径此时为 +50，对比确认两者不同
    assert.equal(afterSpend.todayGoldGained, 50);

    // 再 +300 收入 → 累计 500
    const again = stats.getStats({}, snapshot(1350), true, {});
    assert.equal(again.todayGoldEarned, 500, 'only positive deltas accumulate');
    assert.equal(again.todayGoldGained, 350, 'net still reflects spend');
});

test('todayGoldEarned survives same-day restart via persistence', () => {
    const id = account(2);
    stats.initStatsWithPersistence(id, 1000, 100);
    stats.getStats({}, snapshot(1000), true, {});
    stats.getStats({}, snapshot(1250), true, {}); // +250
    stats.getStats({}, snapshot(1100), true, {}); // -150 spend
    stats.saveStats();

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats', `${id}.json`), 'utf8'));
    assert.equal(persisted.dailyGoldEarned.value, 250);

    stats.initStatsWithPersistence(id, 1100, 100);
    const afterRestart = stats.getStats({}, snapshot(1150), true, {}); // +50 after restart
    assert.equal(afterRestart.todayGoldEarned, 300, 'restored 250 + new 50');
});

test('todayGoldEarned is exposed as 0 in default offline status', () => {
    const defaultValue = stats.getStats({}, snapshot(0, 0), false, {});
    assert.equal(typeof defaultValue.todayGoldEarned, 'number');
});
