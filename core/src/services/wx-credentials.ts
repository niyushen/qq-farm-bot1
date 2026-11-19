export {};
const { getNativeWxLoginCode } = require('./wx-login/native-protocol');
const { WxLoginService } = require('./wx-login/service');

/** 农场小程序 AppID（与 wx-login 路由的 TARGET_APP_ID 一致） */
const FARM_APP_ID = 'wx5306c5978fdb76e4';

/**
 * 微信可再生凭证服务（对齐 qq-farm-bot 当前机制）。
 *
 * - 按服务端 expires_in 提前 35–45 分钟滚动续期 loginBuffer/refreshtoken；
 * - refreshtoken 为滚动凭证，刷新成功后旧值立即失效，成功/失败都必须落盘新值；
 * - 先用现有 loginBuffer 换 Code，只有被明确拒绝时才续期重试，避免每次启动
 *   都拿可能局部异常的 refresh 接口挡住仍然有效的凭证。
 */

const wxLoginService = new WxLoginService();

/** 同一账号的凭证操作串行化，避免保活/刷新/重登并发滚动凭证互相覆盖 */
const accountCredentialLocks = new Map<string, Promise<any>>();
/** 去重并发发起的同一账号换 Code 请求 */
const farmCodeRequests = new Map<string, Promise<any>>();

function withAccountCredentialLock<T>(openid: string, accountId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${String(openid || '')}:${String(accountId || '')}`;
    const prev = accountCredentialLocks.get(key) || Promise.resolve();
    const next = prev.then(operation, operation);
    accountCredentialLocks.set(key, next.finally(() => {
        if (accountCredentialLocks.get(key) === next) accountCredentialLocks.delete(key);
    }).catch(() => undefined));
    return next;
}

function errorMessage(error: unknown): string {
    return (error instanceof Error) ? error.message : String(error || 'unknown');
}

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/**
 * 明确不可恢复的授权失效。只认服务端给出的确定信号；超时/连接失败不在此列，
 * 避免把临时网络问题误判为需要用户重新扫码。
 */
function isDefinitiveWxCredentialError(raw: unknown): boolean {
    const message = String(raw || '').toLowerCase();
    if (/\b40188\b/.test(message)) return true;
    if (message.includes('授权范围') && (message.includes('失效') || message.includes('无效') || message.includes('重新扫码'))) return true;
    if (/code=-101\b/.test(message) && message.includes('credential response rejected')) return true;
    if (message.includes('40030') || message.includes('42007')) return true;
    if (/refresh[ _-]?token/.test(message) && (message.includes('-109') || message.includes('empty token'))) return true;
    return /(?:invalid|expired)\s+(?:refresh[ _-]*)?(?:token|credential)\b/.test(message)
        || /(?:refresh[ _-]*)?(?:token|credential)\s+(?:is\s+)?(?:expired|invalid)\b/.test(message)
        || /凭证已?(?:过期|失效)/.test(message)
        || /invalid scope/.test(message);
}

/** 哪些换 Code 错误值得用 refreshtoken 续期后重试 */
function shouldRefreshWxCredentialForCodeError(raw: unknown): boolean {
    const message = String(raw || '').toLowerCase();
    return message.includes('manualauth rejected')
        || message.includes('invalid scope')
        || message.includes('授权范围')
        || message.includes('40188')
        || message.includes('40030')
        || message.includes('42007')
        || message.includes('credential expired')
        || message.includes('凭证已失效');
}

/** MMTLS/凭据错误 → 可读指引，并抹除 token 内容 */
function humanizeWxCodeError(raw: unknown): string {
    const s = String(raw || '').replace(/(\btoken\s+)[^\s,;]+/gi, '$1[REDACTED]');
    if (s.includes('ManualAuth rejected')) return '微信登录凭证已失效，请在面板重新扫码登录';
    if (isDefinitiveWxCredentialError(s)) return '微信授权已失效，请重新扫码登录';
    if (s.includes('socket read timeout') || s.includes('Unable to establish') || s.includes('invalid HTTP response')) {
        return '无法连接微信服务器（网络波动），请稍后重试；若持续失败请重新扫码登录';
    }
    return s;
}

function asRotatedCredentialError(error: unknown): Error & Record<string, any> {
    return (error instanceof Error ? error : new Error(String(error))) as Error & Record<string, any>;
}

function buildCredentialMetadata(source: unknown, previous: unknown = {}, includeSuccess = false): Record<string, any> {
    const data = asRecord(source);
    const prev = asRecord(previous);
    const result: Record<string, any> = {};
    const expiresAt = Number(data.credentialExpiresAt);
    const expiresIn = Number(data.credentialExpiresIn);
    const observedAt = Number(data.refreshTokenObservedAt);
    const hasRefreshToken = Boolean(String(data.refreshtoken || data.refreshToken || ''));
    if (Number.isFinite(expiresAt) && expiresAt > 0) result.wxCredentialExpiresAt = Math.floor(expiresAt);
    if (Number.isFinite(expiresIn) && expiresIn > 0) result.wxCredentialExpiresIn = Math.floor(expiresIn);
    if (observedAt > 0 || data.refreshTokenRotated === true || (hasRefreshToken && !Number(prev.wxRefreshTokenObservedAt))) {
        result.wxRefreshTokenObservedAt = observedAt > 0 ? Math.floor(observedAt) : Date.now();
    }
    if (includeSuccess) {
        result.wxCredentialLastSuccessAt = Date.now();
        if (hasRefreshToken) result.wxRefreshTokenObservedAt = Date.now();
    }
    return result;
}

function persistAccountFields(addOrUpdateAccount: (acc: any) => any, account: any, updates: Record<string, any>): void {
    if (!addOrUpdateAccount || !account || !account.id) return;
    try {
        addOrUpdateAccount({ id: account.id, ...updates });
    } catch {
        // 持久化失败只记录，不影响主流程
    }
}

/**
 * 微信凭证主动保活：按服务端有效期滚动续期，不申请游戏 Code、不重启 Worker。
 */
async function keepWxCredentialAlive(account: any, options: { shouldContinue?: () => boolean } = {}): Promise<{ Success: boolean; Message?: string; definitive: boolean; expiresAt?: number }> {
    const acc = account || {};
    if (!acc.wxid || !acc.refreshtoken || !acc.loginBuffer) {
        return { Success: false, Message: '缺少微信凭证（refreshtoken/loginBuffer），请重新扫码登录', definitive: true };
    }
    const store = require('../models/store');
    return withAccountCredentialLock(acc.wxid, acc.id, async () => {
        try {
            const refreshed = await wxLoginService.refreshLoginBuffer({
                openid: String(acc.wxid),
                refreshtoken: String(acc.refreshtoken),
                accesstoken: String(acc.accesstoken || ''),
                cookies: new Map(),
            }, {
                shouldContinue: options.shouldContinue,
                onCredentialsRefreshed: async (checkpoint: Record<string, any>) => {
                    persistAccountFields(store.addOrUpdateAccount, acc, {
                        refreshtoken: checkpoint.refreshtoken,
                        accesstoken: checkpoint.accesstoken,
                        ...buildCredentialMetadata(checkpoint, acc, false),
                    });
                },
            });
            persistAccountFields(store.addOrUpdateAccount, acc, {
                loginBuffer: refreshed.loginBuffer,
                refreshtoken: refreshed.refreshtoken,
                accesstoken: refreshed.accesstoken || acc.accesstoken || '',
                ...buildCredentialMetadata(refreshed, acc, true),
            });
            return { Success: true, definitive: false, expiresAt: Number(refreshed.credentialExpiresAt) || 0 };
        } catch (error) {
            const rotatedError = asRotatedCredentialError(error);
            const updates: Record<string, any> = {};
            if (rotatedError.refreshtoken) updates.refreshtoken = rotatedError.refreshtoken;
            if (rotatedError.accesstoken) updates.accesstoken = rotatedError.accesstoken;
            Object.assign(updates, buildCredentialMetadata(rotatedError, acc, false));
            if (Object.keys(updates).length > 0) persistAccountFields(store.addOrUpdateAccount, acc, updates);
            const message = humanizeWxCodeError(rotatedError.message);
            return { Success: false, Message: message, definitive: isDefinitiveWxCredentialError(rotatedError.message) };
        }
    });
}

/**
 * 用持久化凭证换发新 Code。
 * 先用当前 loginBuffer；仅当被明确拒绝时才续期并重试一次。
 */
async function issueFarmCodeForAccount(account: any, options: { shouldContinue?: () => boolean } = {}): Promise<{ Success: boolean; Data?: { code: string }; Message?: string; definitive?: boolean }> {
    const acc = account || {};
    const wxid = String(acc.wxid || '').trim();
    if (!wxid) return { Success: false, Message: '账号缺少 wxid，无法自动刷新 Code', definitive: false };
    if (!acc.loginBuffer) return { Success: false, Message: '账号缺少登录凭证（loginBuffer），请重新扫码登录', definitive: true };

    const store = require('../models/store');
    const requestKey = `account:${String(acc.id || wxid)}`;
    const inFlight = farmCodeRequests.get(requestKey);
    if (inFlight) return inFlight;

    const operation = withAccountCredentialLock(wxid, String(acc.id || ''), async () => {
        let latest: any = acc;
        try {
            const data = store.getAccounts();
            const found = (data.accounts || []).find((a: any) => String(a.id) === String(acc.id));
            if (found) latest = found;
        } catch { /* keep acc */ }

        if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
            return { Success: false, Message: '请求已取消或被更新的扫码取代', definitive: false };
        }

        try {
            let code = '';
            try {
                code = await getNativeWxLoginCode(String(latest.loginBuffer), FARM_APP_ID);
            } catch (issueError) {
                const msg = errorMessage(issueError);
                const definitiveIssue = isDefinitiveWxCredentialError(msg);
                const refreshable = latest.refreshtoken && String(latest.refreshtoken).trim();
                if (!refreshable || (!definitiveIssue && !shouldRefreshWxCredentialForCodeError(msg))) {
                    return {
                        Success: false,
                        Message: `获取 Code 失败: ${humanizeWxCodeError(msg)}`,
                        definitive: definitiveIssue,
                    };
                }
                try {
                    const refreshed = await wxLoginService.refreshLoginBuffer({
                        openid: String(latest.wxid),
                        refreshtoken: String(latest.refreshtoken),
                        accesstoken: String(latest.accesstoken || ''),
                        cookies: new Map(),
                    }, {
                        shouldContinue: options.shouldContinue,
                        onCredentialsRefreshed: async (checkpoint: Record<string, any>) => {
                            persistAccountFields(store.addOrUpdateAccount, latest, {
                                refreshtoken: checkpoint.refreshtoken,
                                accesstoken: checkpoint.accesstoken,
                                ...buildCredentialMetadata(checkpoint, latest, false),
                            });
                        },
                    });
                    persistAccountFields(store.addOrUpdateAccount, latest, {
                        loginBuffer: refreshed.loginBuffer,
                        refreshtoken: refreshed.refreshtoken,
                        accesstoken: refreshed.accesstoken || latest.accesstoken || '',
                        ...buildCredentialMetadata(refreshed, latest, true),
                    });
                    latest = { ...latest, ...refreshed };
                    code = await getNativeWxLoginCode(refreshed.loginBuffer, FARM_APP_ID);
                } catch (refreshError) {
                    const rotatedError = asRotatedCredentialError(refreshError);
                    const updates: Record<string, any> = {};
                    if (rotatedError.refreshtoken) updates.refreshtoken = rotatedError.refreshtoken;
                    if (rotatedError.accesstoken) updates.accesstoken = rotatedError.accesstoken;
                    Object.assign(updates, buildCredentialMetadata(rotatedError, latest, false));
                    if (Object.keys(updates).length > 0) persistAccountFields(store.addOrUpdateAccount, latest, updates);
                    return {
                        Success: false,
                        Message: `获取 Code 失败: ${humanizeWxCodeError(rotatedError.message)}`,
                        definitive: isDefinitiveWxCredentialError(rotatedError.message),
                    };
                }
            }
            if (!code) return { Success: false, Message: '获取 Code 失败（服务端未返回 code）', definitive: false };
            if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
                return { Success: false, Message: '请求已取消或被更新的扫码取代', definitive: false };
            }
            persistAccountFields(store.addOrUpdateAccount, latest, buildCredentialMetadata(latest, latest, true));
            return { Success: true, Data: { code }, definitive: false };
        } catch (error) {
            return {
                Success: false,
                Message: `获取 Code 失败: ${humanizeWxCodeError(errorMessage(error))}`,
                definitive: isDefinitiveWxCredentialError(error),
            };
        }
    });

    farmCodeRequests.set(requestKey, operation);
    operation.finally(() => {
        if (farmCodeRequests.get(requestKey) === operation) farmCodeRequests.delete(requestKey);
    });
    return operation;
}

module.exports = {
    buildCredentialMetadata,
    humanizeWxCodeError,
    isDefinitiveWxCredentialError,
    shouldRefreshWxCredentialForCodeError,
    keepWxCredentialAlive,
    issueFarmCodeForAccount,
};
