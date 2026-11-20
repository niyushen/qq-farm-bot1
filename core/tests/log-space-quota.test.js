/**
 * 日志空间拆分与配额 —— 牧场 / 农场双池独立计数、独立截断与可见条数限制。
 *
 * 依赖 dist/，必须先执行 `pnpm -C core build:ts` 再跑，否则会拿到旧产物导致假失败。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeState, LOG_POOL_LIMIT } = require('../dist/runtime/runtime-state');
const { createDataProvider } = require('../dist/runtime/data-provider');

function harness() {
    const state = createRuntimeState({
        store: { getConfigSnapshot: () => ({}) },
        operationKeys: [],
    });

    const provider = createDataProvider({
        workers: {},
        logPools: state.logPools,
        accountLogs: [],
        store: {},
        getAccounts: () => ({ accounts: [] }),
        callWorkerApi: async () => ({}),
        buildDefaultStatus: id => ({ accountId: id }),
        normalizeStatusForPanel: d => d,
        // 用真实的 filterLogs，验证空间过滤与字段过滤的组合行为
        filterLogs: state.filterLogs,
        addAccountLog() {},
        nextConfigRevision: () => 1,
        broadcastConfigToWorkers() {},
        buildConfigSnapshotForAccount: () => ({}),
        startWorker: () => false,
        stopWorker() {},
        restartWorker() {},
    });

    return { state, provider };
}

function makeEntry(index, moduleName, accountId) {
    const isRanch = moduleName === 'ranch';
    return {
        time: '2026-01-01 00:00:00',
        tag: isRanch ? '牧场' : '农场',
        msg: `m${index}`,
        meta: {
            module: moduleName,
            event: isRanch ? `ranch_e${index}` : `farm_e${index}`,
        },
        ts: 100000 + index,
        accountId,
    };
}

test('牧场日志与农场日志分流到不同的内存池', () => {
    const { state } = harness();
    state.appendLog(makeEntry(1, 'ranch', 'a1'));
    state.appendLog(makeEntry(2, 'farm', 'a1'));
    // tag 兜底：没有 module，但 tag 是牧场
    state.appendLog({ ...makeEntry(3, 'farm', 'a1'), tag: '牧场', meta: {} });
    // event 前缀兜底：没有 module，event 以 ranch_ 开头
    state.appendLog({ ...makeEntry(4, 'farm', 'a1'), meta: { event: 'ranch_x' } });

    assert.equal(state.logPools.ranch.length, 3);
    assert.equal(state.logPools.farm.length, 1);
    assert.equal(state.logPools.ranch[0].space, 'ranch');
    assert.equal(state.logPools.farm[0].space, 'farm');
    assert.ok(state.logPools.ranch.every(l => l.space === 'ranch'));
    assert.ok(state.logPools.farm.every(l => l.space === 'farm'));
});

test('每个日志池独立按 2000 条上限截断', () => {
    const { state } = harness();
    for (let i = 0; i < 2500; i++) state.appendLog(makeEntry(i, 'ranch', 'a1'));
    for (let i = 0; i < 10; i++) state.appendLog(makeEntry(i, 'farm', 'a1'));

    assert.equal(LOG_POOL_LIMIT, 2000);
    assert.equal(state.logPools.ranch.length, 2000);
    // 最旧的被挤出，最新的保留
    assert.equal(state.logPools.ranch[0].msg, 'm500');
    assert.equal(state.logPools.ranch[1999].msg, 'm2499');
    // 农场池独立计数，不受牧场池刷屏影响
    assert.equal(state.logPools.farm.length, 10);
    assert.equal(state.logPools.farm[0].msg, 'm0');
});

test('单账号按空间最多可见最新 100 条', () => {
    const { state, provider } = harness();
    for (let i = 0; i < 150; i++) state.appendLog(makeEntry(i, 'ranch', 'a1'));
    for (let i = 0; i < 150; i++) state.appendLog(makeEntry(i, 'farm', 'a1'));
    state.appendLog(makeEntry(999, 'farm', 'a2'));

    const ranch = provider.getLogs('a1', { space: 'ranch', limit: 100 });
    const farm = provider.getLogs('a1', { space: 'farm', limit: 100 });

    assert.equal(ranch.length, 100);
    assert.ok(ranch.every(l => l.space === 'ranch'));
    assert.ok(ranch.every(l => l.accountId === 'a1'));
    assert.equal(ranch[ranch.length - 1].msg, 'm149');

    assert.equal(farm.length, 100);
    assert.ok(farm.every(l => l.space === 'farm'));
    assert.ok(farm.every(l => l.accountId === 'a1'));
    assert.equal(farm[farm.length - 1].msg, 'm149');
});

test('不指定 space 时两池合并，仍受 limit 约束且保持时间升序', () => {
    const { state, provider } = harness();
    for (let i = 0; i < 150; i++) state.appendLog(makeEntry(i, 'ranch', 'a1'));
    for (let i = 0; i < 150; i++) state.appendLog(makeEntry(i, 'farm', 'a1'));

    const merged = provider.getLogs('a1', { limit: 100 });
    assert.equal(merged.length, 100);
    assert.ok(merged.some(l => l.space === 'ranch'));
    assert.ok(merged.some(l => l.space === 'farm'));
    for (let i = 1; i < merged.length; i++) {
        assert.ok(merged[i].ts >= merged[i - 1].ts, `第 ${i} 条 ts 未按升序`);
    }
});

test('clearLogs 同时清理两个空间的该账号日志', () => {
    const { state, provider } = harness();
    state.appendLog(makeEntry(1, 'ranch', 'a1'));
    state.appendLog(makeEntry(2, 'farm', 'a1'));
    state.appendLog(makeEntry(3, 'ranch', 'a2'));
    state.appendLog(makeEntry(4, 'farm', 'a2'));

    const one = provider.clearLogs('a1');
    assert.equal(one.cleared, 2);
    assert.equal(one.accountId, 'a1');
    assert.equal(state.logPools.ranch.length, 1);
    assert.equal(state.logPools.farm.length, 1);
    assert.equal(state.logPools.ranch[0].accountId, 'a2');
    assert.equal(state.logPools.farm[0].accountId, 'a2');

    const all = provider.clearLogs('all');
    assert.equal(all.cleared, 'all');
    assert.equal(state.logPools.ranch.length, 0);
    assert.equal(state.logPools.farm.length, 0);
});

test('clearLogs 可按空间单独清理', () => {
    const { state, provider } = harness();
    state.appendLog(makeEntry(1, 'ranch', 'a1'));
    state.appendLog(makeEntry(2, 'farm', 'a1'));

    const result = provider.clearLogs('a1', { space: 'ranch' });
    assert.equal(result.cleared, 1);
    assert.equal(state.logPools.ranch.length, 0);
    assert.equal(state.logPools.farm.length, 1);
});

test('空间过滤与字段过滤可叠加', () => {
    const { state, provider } = harness();
    state.appendLog(makeEntry(1, 'ranch', 'a1'));
    state.appendLog(makeEntry(2, 'farm', 'a1'));

    assert.equal(provider.getLogs('a1', { space: 'ranch', module: 'ranch' }).length, 1);
    assert.equal(provider.getLogs('a1', { space: 'farm', module: 'ranch' }).length, 0);
    assert.equal(provider.getLogs('a1', { space: 'ranch', keyword: 'm1' }).length, 1);
    assert.equal(provider.getLogs('a1', { space: 'ranch', keyword: 'm2' }).length, 0);
});
