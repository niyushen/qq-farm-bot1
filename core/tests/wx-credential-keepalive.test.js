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

test('recoverable -109 RC_PARAMS_INVALID is not definitive', () => {
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('WeChat token failed: code=-109 msg=RC_PARAMS_INVALID'), false);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('WeChat refresh_token failed: code=-109 credential response rejected'), false);
  // 真正空 token 仍属明确失效
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('WeChat refresh_token failed: RefreshToken empty token'), true);
});

test('ManualAuth rejected handshake failure is not definitive unless an explicit revoke signal is present', () => {
  // 换 Code 时 MMTLS 握手偶发失败：临时，不应永久阻断账号
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('ManualAuth rejected: code=unknown message=handshake timeout'), false);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('获取 Code 失败: ManualAuth rejected: code=0 message=decrypt failed'), false);
  // 但带上明确撤销信号时仍是 definitive
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('ManualAuth rejected: code=40188 message=invalid scope'), true);
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('ManualAuth rejected: code=-101 message=credential response rejected'), true);
});

test('humanized Chinese message is not re-classified as definitive by the service', () => {
  // 结构化 definitive 字段是唯一真相源
  assert.equal(wxCredentials.isDefinitiveWxCredentialError('微信登录凭证已失效，请在面板重新扫码登录'), true);
  // 但保活调用方必须只信结构化字段，不把这句文案二次喂进判定；
  // 见 auto-code-refresh 的 isDefinitiveCredentialFailure：带 Success 字段且非 definitive 的结果被忽略。
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
