'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');
const http = require('node:http');

const { mountFarmRoutes } = require('../dist/controllers/admin/farm-routes');
const { createAuthRequired } = require('../dist/controllers/admin/middleware');
const { USER_ROLES } = require('../dist/config/user-system');

const TOKEN = 'test-token';

/**
 * 挂载真实路由（fake provider），用真实 HTTP 请求验证一键重连接口的完整链路：
 * 鉴权 → 账号归属 → provider.reconnectAccount → 结构化响应。
 */
function createServer({ provider, accounts = [] } = {}) {
    const app = express();
    app.use(express.json());

    const sessions = new Map([[TOKEN, {
        username: 'admin',
        role: USER_ROLES.SUPER_ADMIN,
        accountLimit: -1,
        subscription: { enabled: true },
        createdAt: Date.now(),
    }]]);

    const ctx = {
        tokens: new Set([TOKEN]),
        sessions,
        app,
        server: null,
        io: null,
        provider: provider || {
            getAccounts: () => ({ accounts }),
            reconnectAccount: async () => ({ ok: true, reason: 'reconnected', message: '重连成功' }),
        },
    };

    // 与 auth-routes 一致：/api 下所有请求都要过会话校验
    app.use('/api', createAuthRequired(ctx));
    mountFarmRoutes(app, ctx);

    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

async function post(url, path, headers = {}) {
    const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
    });
    return { status: response.status, body: await response.json() };
}

test('一键重连：鉴权通过且账号归属校验通过时返回成功', async () => {
    const ctx = await createServer({});
    try {
        const result = await post(ctx.url, '/api/accounts/1/reconnect', { 'x-admin-token': TOKEN });
        assert.equal(result.status, 200);
        assert.equal(result.body.ok, true);
        assert.equal(result.body.reason, 'reconnected');
        assert.equal(result.body.needRescan, false);
    }
    finally {
        await ctx.close();
    }
});

test('一键重连：缺少 token 时返回 401', async () => {
    const ctx = await createServer({});
    try {
        const result = await post(ctx.url, '/api/accounts/1/reconnect');
        assert.equal(result.status, 401);
        assert.equal(result.body.ok, false);
    }
    finally {
        await ctx.close();
    }
});

test('一键重连：需要重新扫码时用 200 + ok:false + needRescan 表达', async () => {
    const provider = {
        getAccounts: () => ({ accounts: [] }),
        reconnectAccount: async () => ({
            ok: false, reason: 'need_rescan', message: '微信授权已失效，请重新扫码登录',
        }),
    };
    const ctx = await createServer({ provider });
    try {
        const result = await post(ctx.url, '/api/accounts/1/reconnect', { 'x-admin-token': TOKEN });
        assert.equal(result.status, 200);
        assert.equal(result.body.ok, false);
        assert.equal(result.body.reason, 'need_rescan');
        assert.equal(result.body.needRescan, true);
        assert.match(result.body.error, /重新扫码/);
    }
    finally {
        await ctx.close();
    }
});

test('一键重连：provider 未实现该能力时返回 501', async () => {
    const ctx = await createServer({
        provider: { getAccounts: () => ({ accounts: [] }) },
    });
    try {
        const result = await post(ctx.url, '/api/accounts/1/reconnect', { 'x-admin-token': TOKEN });
        assert.equal(result.status, 501);
        assert.equal(result.body.ok, false);
    }
    finally {
        await ctx.close();
    }
});
