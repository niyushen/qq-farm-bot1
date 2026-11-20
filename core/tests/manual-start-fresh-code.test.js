const assert = require('node:assert/strict');
const test = require('node:test');
const { createDataProvider } = require('../dist/runtime/data-provider');

function harness({ accounts, refreshResult = true, refreshThrows = false } = {}) {
    const refreshCalls = [];
    const startWorkerCalls = [];

    const provider = createDataProvider({
        workers: {},
        logPools: { farm: [], ranch: [] },
        accountLogs: [],
        store: {},
        getAccounts: () => ({ accounts }),
        callWorkerApi: async () => ({}),
        buildDefaultStatus: id => ({ accountId: id }),
        normalizeStatusForPanel: d => d,
        filterLogs: list => list,
        addAccountLog() {},
        nextConfigRevision: () => 1,
        broadcastConfigToWorkers() {},
        buildConfigSnapshotForAccount: () => ({}),
        startWorker: acc => { startWorkerCalls.push(acc.id); return true; },
        stopWorker() {},
        restartWorker: acc => { startWorkerCalls.push(`restart:${acc.id}`); },
        refreshAccountCode: async (id, reason) => {
            refreshCalls.push({ id: String(id), reason });
            if (refreshThrows) throw new Error('refresh boom');
            return refreshResult;
        },
    });

    return { provider, refreshCalls, startWorkerCalls };
}

test('手动启动微信扫码号：先刷新 Code，刷新成功即拉起（内部 restartWorker），不再用旧 Code 直接启动', async () => {
    const h = harness({ accounts: [{ id: '1', name: 'wx', platform: 'wx', loginBuffer: Buffer.from('x') }] });
    const ok = await h.provider.startAccountWithFreshCode('1');

    assert.equal(ok, true);
    assert.deepEqual(h.refreshCalls, [{ id: '1', reason: 'manual_start' }]);
    // 刷新成功路径：provider 不再直接 startWorker（refreshAccountCode 内部已 restartWorker 拉起）
    assert.deepEqual(h.startWorkerCalls, []);
});

test('手动启动微信扫码号：刷新失败回退用旧 Code 直接启动', async () => {
    const h = harness({ accounts: [{ id: '1', name: 'wx', platform: 'wx', loginBuffer: Buffer.from('x') }], refreshResult: false });
    const ok = await h.provider.startAccountWithFreshCode('1');

    assert.equal(ok, true);
    assert.deepEqual(h.refreshCalls, [{ id: '1', reason: 'manual_start' }]);
    assert.deepEqual(h.startWorkerCalls, ['1']);
});

test('手动启动微信扫码号：刷新抛异常也回退直接启动，不把异常抛给接口', async () => {
    const h = harness({ accounts: [{ id: '1', name: 'wx', platform: 'wx', loginBuffer: Buffer.from('x') }], refreshThrows: true });
    const ok = await h.provider.startAccountWithFreshCode('1');

    assert.equal(ok, true);
    assert.deepEqual(h.startWorkerCalls, ['1']);
});

test('手动启动 QQ 号：不需要刷新凭证，直接启动', async () => {
    const h = harness({ accounts: [{ id: '2', name: 'qq', platform: 'qq' }] });
    const ok = await h.provider.startAccountWithFreshCode('2');

    assert.equal(ok, true);
    assert.deepEqual(h.refreshCalls, []);
    assert.deepEqual(h.startWorkerCalls, ['2']);
});

test('手动启动不存在的账号：返回 false', async () => {
    const h = harness({ accounts: [] });
    const ok = await h.provider.startAccountWithFreshCode('missing');

    assert.equal(ok, false);
    assert.deepEqual(h.refreshCalls, []);
    assert.deepEqual(h.startWorkerCalls, []);
});
