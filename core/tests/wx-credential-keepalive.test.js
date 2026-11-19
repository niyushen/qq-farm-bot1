'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAutoCodeRefreshService,
  nextCredentialKeepaliveDelayMs,
  resolveKickoutDelayMs,
} = require('../dist/runtime/auto-code-refresh');
const wxCredentials = require('../dist/services/wx-credentials');

const MINUTE = 60 * 1000;

test('keepalive targets 35-45 minutes before server expiry', () => {
  const now = 1_800_000_000_000;
  const expiresAt = now + 120 * MINUTE;
  const delay = nextCredentialKeepaliveDelayMs({ wxCredentialExpiresAt: expiresAt }, { now, random: () => 0.5 });
  // 120min - 40min ahead = 80min from now.
  assert.equal(delay, 80 * MINUTE);
});

test('legacy account without expiry migrates within 2-8 seconds', () => {
  const delay = nextCredentialKeepaliveDelayMs({}, { random: () => 0 });
  assert.equal(delay, 2000);
});

test('temporary failures back off 5/10/20 minutes with jitter', () => {
  assert.equal(nextCredentialKeepaliveDelayMs({}, { reason: 'retry', failureCount: 1, random: () => 0 }), 5 * MINUTE);
  assert.equal(nextCredentialKeepaliveDelayMs({}, { reason: 'retry', failureCount: 2, random: () => 0 }), 10 * MINUTE);
  assert.equal(nextCredentialKeepaliveDelayMs({}, { reason: 'retry', failureCount: 3, random: () => 0 }), 20 * MINUTE);
  assert.equal(nextCredentialKeepaliveDelayMs({}, { reason: 'retry', failureCount: 9, random: () => 0 }), 20 * MINUTE);
});

test('definitive failure rechecks at 6 hours', () => {
  const delay = nextCredentialKeepaliveDelayMs({}, { reason: 'definitive', random: () => 0 });
  assert.equal(delay, 6 * 60 * MINUTE);
});

test('definitive WeChat credential errors are recognized', () => {
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('WeChat refresh_token failed: code=40188 invalid scope'), true);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('code=-101 credential response rejected'), true);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('WeChat login_buffer failed: code=40030 credential response rejected'), true);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('socket read timeout'), false);
});

test('credential metadata persists server expiry', () => {
  const meta = wxCredentials.buildCredentialMetadata({
    credentialExpiresAt: 1_800_000_000_000,
    credentialExpiresIn: 7200,
    refreshtoken: 'rt',
    refreshTokenRotated: true,
  }, {}, false);
  assert.equal(meta.wxCredentialExpiresAt, 1_800_000_000_000);
  assert.equal(meta.wxCredentialExpiresIn, 7200);
  assert.ok(meta.wxRefreshTokenObservedAt > 0);
});

test('kickout takeover uses escalating backoff', () => {
  assert.equal(resolveKickoutDelayMs(null, 0), 5 * MINUTE);
  assert.equal(resolveKickoutDelayMs(null, 1), 30 * MINUTE);
  assert.equal(resolveKickoutDelayMs(null, 2), 60 * MINUTE);
  assert.equal(resolveKickoutDelayMs(null, 3), 180 * MINUTE);
});

test('rescheduleAll arms credential keepalive but no periodic code refresh', () => {
  const account = {
    id: '1',
    platform: 'wx',
    wxid: 'wxid-1',
    loginBuffer: 'login-buffer',
    refreshtoken: 'refresh-token',
    wxCredentialExpiresAt: Date.now() + 120 * MINUTE,
    autoLogin: true,
  };
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: () => ({}),
    resolveWorkerControls: () => ({}),
    log: () => {},
    addAccountLog: () => {},
    needsWxRescan: () => false,
  });
  service.rescheduleAll();
  const names = service.getTaskNames();
  assert.ok(names.includes('wx_keepalive_1'));
  assert.ok(!names.includes('refresh_1'), 'must not schedule periodic Code refresh');
  service.stopAccount('1');
});
