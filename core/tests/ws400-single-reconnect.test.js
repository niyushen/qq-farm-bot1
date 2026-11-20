const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createWorkerManager } = require('../dist/runtime/worker-manager');

function harness({ refreshOk = false } = {}) {
    const workers = {};
    const reloginCalls = [];
    const refreshCalls = [];
    let lastChild = null;

    class FakeChild extends EventEmitter {
        send() {}
        kill() {}
    }

    const mgr = createWorkerManager({
        fork: () => { lastChild = new FakeChild(); return lastChild; },
        WorkerThread: undefined,
        runtimeMode: 'fork',
        processRef: { env: {}, execPath: '', pkg: undefined },
        mainEntryPath: 'main.js',
        workerScriptPath: 'worker.js',
        workers,
        appendLog() {},
        log() {},
        addAccountLog() {},
        normalizeStatusForPanel: d => d,
        buildConfigSnapshotForAccount: () => ({}),
        getOfflineAutoDeleteMs: () => 0,
        triggerOfflineReminder() {},
        addOrUpdateAccount: a => a,
        deleteAccount() {},
        refreshAccountCode: async (_id, reason) => {
            refreshCalls.push(reason);
            return refreshOk;
        },
        scheduleAutoRelogin: (_id, reason) => {
            reloginCalls.push(reason);
            return true;
        },
        shouldStopAutoRelogin: () => false,
    });

    mgr.startWorker({ id: '1', name: 'wx-account', platform: 'wx' });
    const tick = () => new Promise(r => setImmediate(r));
    return { mgr, workers, lastChild: () => lastChild, reloginCalls, refreshCalls, tick };
}

test('WS 400 掉线：ws_error 即时恢复失败降级阶梯，account_disconnected 不再重复排重登', async () => {
    const h = harness({ refreshOk: false });
    // worker 端一次 400 会先后发这两条消息
    h.lastChild().emit('message', { type: 'ws_error', code: 400, message: 'Unexpected server response: 400' });
    h.lastChild().emit('message', {
        type: 'account_disconnected', source: 'ws_error', code: 400,
        reason: 'Unexpected server response: 400', phase: 'connecting',
    });
    await h.tick();

    assert.deepEqual(h.refreshCalls, ['ws_400'], '即时恢复只发起一次');
    assert.equal(h.reloginCalls.length, 1, '阶梯重登只排一次（不能既 ws_400_refresh_failed 又 ws_reconnect_failed）');
    assert.match(h.reloginCalls[0], /ws_400_refresh_failed/, '唯一一次阶梯来自即时恢复失败降级');
});

test('WS 400 掉线：即时恢复成功时完全不排阶梯重登', async () => {
    const h = harness({ refreshOk: true });
    h.lastChild().emit('message', { type: 'ws_error', code: 400, message: 'Unexpected server response: 400' });
    h.lastChild().emit('message', {
        type: 'account_disconnected', source: 'ws_error', code: 400,
        reason: 'Unexpected server response: 400', phase: 'connecting',
    });
    await h.tick();

    assert.deepEqual(h.refreshCalls, ['ws_400']);
    assert.deepEqual(h.reloginCalls, [], '恢复成功时不应有任何阶梯重登');
});

test('非 WS 400 断线（如 ws_close）仍按阶梯重登', async () => {
    const h = harness({ refreshOk: false });
    h.lastChild().emit('message', {
        type: 'account_disconnected', source: 'ws_close', code: 1006,
        reason: '连接已断开', phase: 'online',
    });
    await h.tick();

    assert.deepEqual(h.refreshCalls, [], '非 400 断线不走即时恢复');
    assert.equal(h.reloginCalls.length, 1, '非 400 断线仍排一次阶梯重登');
    assert.match(h.reloginCalls[0], /ws_reconnect_failed/);
});
