'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDataProvider } = require('../dist/runtime/data-provider');

/**
 * 构造一个最小可用的 data-provider：只关心 reconnectAccount 行为，
 * 其余能力用桩件填充即可。
 */
function createProvider(overrides = {}) {
    const accounts = overrides.accounts || [];
    const calls = { refresh: [], rescan: [] };

    const provider = createDataProvider({
        workers: {},
        logPools: { farm: [], ranch: [] },
        accountLogs: [],
        store: {},
        getAccounts: () => ({ accounts }),
        callWorkerApi: async () => ({}),
        buildDefaultStatus: () => ({}),
        normalizeStatusForPanel: (data) => data,
        filterLogs: (list) => list,
        addAccountLog: () => {},
        nextConfigRevision: () => 1,
        broadcastConfigToWorkers: () => {},
        buildConfigSnapshotForAccount: () => ({}),
        startWorker: () => true,
        stopWorker: () => {},
        restartWorker: () => {},
        refreshAccountCode: async (accountId, reason) => {
            calls.refresh.push({ accountId, reason });
            return overrides.refreshResult === undefined ? true : overrides.refreshResult;
        },
        needsWxRescan: (accountId) => {
            calls.rescan.push(accountId);
            return !!overrides.needsRescan;
        },
    });

    return { provider, calls };
}

test('reconnect refuses non-WeChat accounts', async () => {
    const { provider, calls } = createProvider({
        accounts: [{ id: '1', platform: 'qq', name: 'QQ号' }],
    });

    const result = await provider.reconnectAccount('1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported_platform');
    assert.equal(calls.refresh.length, 0, '非微信账号不应触发换码');
});

test('reconnect reports missing credentials instead of attempting a refresh', async () => {
    const { provider, calls } = createProvider({
        accounts: [{ id: '1', platform: 'wx', name: '微信号' }],
    });

    const result = await provider.reconnectAccount('1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_credential');
    assert.equal(calls.refresh.length, 0, '没有凭据时不应触发换码');
});

test('reconnect asks for a rescan when the credential was revoked', async () => {
    const { provider, calls } = createProvider({
        accounts: [{ id: '1', platform: 'wx', name: '微信号', loginBuffer: 'buffer' }],
        needsRescan: true,
    });

    const result = await provider.reconnectAccount('1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'need_rescan');
    assert.equal(calls.refresh.length, 0, '授权已撤销时换码必然失败，不应再试');
});

test('reconnect refreshes the Code and restarts the account on success', async () => {
    const { provider, calls } = createProvider({
        accounts: [{ id: '1', platform: 'wx', name: '微信号', loginBuffer: 'buffer' }],
        refreshResult: true,
    });

    const result = await provider.reconnectAccount('1');
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'reconnected');
    assert.deepEqual(calls.refresh, [{ accountId: '1', reason: 'manual_reconnect' }]);
});

test('reconnect surfaces transient failures as retryable errors', async () => {
    const { provider } = createProvider({
        accounts: [{ id: '1', platform: 'wx', name: '微信号', loginBuffer: 'buffer' }],
        refreshResult: false,
    });

    const result = await provider.reconnectAccount('1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refresh_failed');
    assert.match(result.message, /重连失败/);
});

test('reconnect rejects unknown accounts', async () => {
    const { provider } = createProvider({ accounts: [] });
    const result = await provider.reconnectAccount('missing');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
});
