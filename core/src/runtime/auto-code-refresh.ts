export {};
const { createScheduler } = require('../services/scheduler');
const wxCredentials = require('../services/wx-credentials');
const wxCredentialGuard = require('../services/wx-credential-guard');

/**
 * 微信凭证保活 / Code 刷新 / 自动重登（对齐 qq-farm-bot 当前机制）。
 *
 * - 在线期间只按服务端有效期提前 35–45 分钟滚动续期，不换 Code、不重启 Worker；
 * - 只有启动/断线/被踢才换 Code；intervalMinutes 仅控制真实断线后的恢复间隔；
 * - 明确授权失效会阻断账号、停止定时器并通过回调触发扫码提醒；
 * - 每日恢复上限 5 次、连续失败 3 次熔断。
 */

const WX_KEEPALIVE_AHEAD_MIN_MS = 35 * 60000;
const WX_KEEPALIVE_AHEAD_MAX_MS = 45 * 60000;
const WX_KEEPALIVE_MIGRATION_MIN_MS = 2000;
const WX_KEEPALIVE_MIGRATION_MAX_MS = 8000;
const WX_KEEPALIVE_RETRY_BASE_MS = 5 * 60000;
const WX_KEEPALIVE_RETRY_MAX_MS = 20 * 60000;
const WX_KEEPALIVE_TERMINAL_RECHECK_MS = 6 * 60 * 60000;

const MAX_DAILY_RECOVERIES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

const RELOGIN_LADDER_MS = [10 * 1000, 30 * 1000, 90 * 1000, 300 * 1000];
const KICKOUT_BACKOFF_STEPS_MS = [5 * 60000, 30 * 60000, 60 * 60000, 3 * 60 * 60000];

function randomDelayBetween(minMs: number, maxMs: number, random: () => number = Math.random): number {
    const low = Math.max(0, Math.floor(Number(minMs) || 0));
    const high = Math.max(low, Math.floor(Number(maxMs) || low));
    return low + Math.floor(random() * (high - low + 1));
}

/** 按 expiresAt 提前 35–45 分钟续期；旧账号迁移、临时失败退避、明确失效低频复查。 */
function nextCredentialKeepaliveDelayMs(account: any = {}, options: any = {}): number {
    const reason = String(options.reason || 'normal');
    const random = typeof options.random === 'function' ? options.random : Math.random;
    if (reason === 'retry') {
        const failures = Math.max(1, Number(options.failureCount) || 1);
        const base = Math.min(WX_KEEPALIVE_RETRY_MAX_MS, WX_KEEPALIVE_RETRY_BASE_MS * (2 ** Math.min(2, failures - 1)));
        return base + randomDelayBetween(0, 60000, random);
    }
    if (reason === 'definitive') {
        return WX_KEEPALIVE_TERMINAL_RECHECK_MS + randomDelayBetween(0, 30 * 60000, random);
    }
    const now = Number(options.now) || Date.now();
    const expiresAt = Number(account && account.wxCredentialExpiresAt) || 0;
    if (expiresAt <= 0) return randomDelayBetween(WX_KEEPALIVE_MIGRATION_MIN_MS, WX_KEEPALIVE_MIGRATION_MAX_MS, random);
    const ahead = randomDelayBetween(WX_KEEPALIVE_AHEAD_MIN_MS, WX_KEEPALIVE_AHEAD_MAX_MS, random);
    const delay = expiresAt - now - ahead;
    return delay > 0 ? Math.floor(delay) : randomDelayBetween(WX_KEEPALIVE_MIGRATION_MIN_MS, WX_KEEPALIVE_MIGRATION_MAX_MS, random);
}

function reloginDelayMs(attempt: number, intervalMinutes = 60): number {
    const index = Math.max(0, (Number(attempt) || 1) - 1);
    if (index < RELOGIN_LADDER_MS.length) return RELOGIN_LADDER_MS[index];
    return Math.max(1, Number(intervalMinutes) || 60) * 60000;
}

function kickoutBackoffMs(attemptIndex: number): number {
    const idx = Math.max(0, Number(attemptIndex) || 0);
    return KICKOUT_BACKOFF_STEPS_MS[Math.min(idx, KICKOUT_BACKOFF_STEPS_MS.length - 1)];
}

function resolveKickoutDelayMs(cfg: any, attemptIndex: number, now = Date.now()): number {
    const delayMinutes = Number(cfg && cfg.delayMinutes) || 0;
    const validUntilRaw = String((cfg && cfg.validUntil) || '').trim();
    const validUntilTs = validUntilRaw ? Date.parse(validUntilRaw) : NaN;
    const overrideActive = delayMinutes > 0 && (!validUntilRaw || (Number.isFinite(validUntilTs) && validUntilTs > now));
    return overrideActive ? delayMinutes * 60000 : kickoutBackoffMs(attemptIndex);
}

function createAutoCodeRefreshService(deps: any) {
    const {
        store,
        getAccounts,
        addOrUpdateAccount,
        resolveWorkerControls,
        log,
        addAccountLog,
    } = deps;
    const onInvalid = typeof deps.onWxCredentialDefinitivelyInvalid === 'function' ? deps.onWxCredentialDefinitivelyInvalid : null;
    const needsWxRescan = typeof deps.needsWxRescan === 'function' ? deps.needsWxRescan : () => false;
    const keepCredentialAlive = typeof deps.keepWxCredentialAlive === 'function' ? deps.keepWxCredentialAlive : wxCredentials.keepWxCredentialAlive;
    const getDelayMs = typeof deps.getCredentialKeepaliveDelayMs === 'function' ? deps.getCredentialKeepaliveDelayMs : nextCredentialKeepaliveDelayMs;
    const noteSuspiciousFailure = typeof deps.noteSuspiciousCredentialFailure === 'function'
        ? deps.noteSuspiciousCredentialFailure : wxCredentialGuard.noteSuspiciousCredentialFailure;
    const clearSuspiciousFailures = typeof deps.clearSuspiciousCredentialFailures === 'function'
        ? deps.clearSuspiciousCredentialFailures : wxCredentialGuard.clearSuspiciousCredentialFailures;

    const scheduler = createScheduler('auto_code_refresh');
    const enableNotices = new Map<string, string>();
    const recoveryState = new Map<string, { date: string; attempts: number; failures: number }>();
    const keepaliveGeneration = new Map<string, number>();
    const credentialGeneration = new Map<string, number>();
    const definitiveCredentialFailures = new Map<string, string>();
    const codeRefreshes = new Map<string, { generation: number; task: Promise<boolean> }>();

    function logEnableNotice(kind: string, accountId: string, message: string, metadata?: any): void {
        const key = `${String(accountId)}:${kind}`;
        if (enableNotices.get(key) === message) return;
        enableNotices.set(key, message);
        log('系统', message, metadata);
    }
    function clearEnableNotices(accountId: string): void {
        enableNotices.delete(`${String(accountId)}:keepalive`);
        enableNotices.delete(`${String(accountId)}:recovery`);
    }
    function getTaskName(accountId: string): string { return `refresh_${String(accountId || '')}`; }
    function getKeepaliveTaskName(accountId: string): string { return `wx_keepalive_${String(accountId || '')}`; }
    function getReloginTaskName(accountId: string): string { return `relogin_${String(accountId || '')}`; }
    function isAutoLogin(account: any): boolean { return !account || account.autoLogin !== false; }

    function findAccount(accountId: string): any {
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        return accounts.find((acc: any) => String(acc.id) === String(accountId));
    }
    function getRecoveryState(accountId: string) {
        const date = new Date().toISOString().slice(0, 10);
        const current = recoveryState.get(String(accountId));
        if (!current || current.date !== date) {
            const fresh = { date, attempts: 0, failures: 0 };
            recoveryState.set(String(accountId), fresh);
            return fresh;
        }
        return current;
    }
    function isRecoveryReason(reason: unknown): boolean {
        return ['ws_400', 'kickout:', 'ws_reconnect_failed:', 'refresh_failed', 'startup']
            .some(prefix => String(reason || '').includes(prefix));
    }
    function isDefinitiveCredentialFailure(error: any): boolean {
        if (!error) return false;
        // 唯一真相源：底层基于「原始」协议错误算出的结构化 definitive。
        if (error.definitive === true) return true;
        // 若对象是 humanize 后的结果（带 Success/Message 字段且无 definitive），
        // 绝不能把人类可读文案再喂给判定器：文案含“凭证已失效”会被正则自我确认成
        // definitive，使临时握手错误被误判为永久失效并停掉保活。
        if (typeof error === 'object' && 'Success' in error && error.definitive !== true) return false;
        // Error 实例：使用原始 message 判定（不含 humanize 前缀的协议错误）。
        const raw = error.rawMessage || (error instanceof Error ? error.message : error);
        return wxCredentials.isDefinitiveWxCredentialError(raw);
    }
    /** -109 单次要退避，连续多次才升级；只认原始协议字段，不扫 humanize 文案。 */
    function isRepeatedInvalidCodeFailure(error: any): boolean {
        if (!error) return false;
        const code = Number(error.wxCode ?? error.code);
        if (code === Number(wxCredentialGuard.REPEATED_INVALID_TOKEN_CODE)) return true;
        const raw = String(error.rawMessage || (error instanceof Error ? error.message : ''));
        return /code\s*=\s*-109\b/.test(raw) || /\bRC_PARAMS_INVALID\b/i.test(raw);
    }
    function suspiciousFailurePayload(account: any, error: any): any {
        return {
            accountId: String(account && account.id || ''),
            owner: String(account && account.username || ''),
            wxid: String(account && account.wxid || ''),
            code: Number(wxCredentialGuard.REPEATED_INVALID_TOKEN_CODE),
            stage: String(error && error.wxStage || ''),
        };
    }
    function noteRepeatedFailure(account: any, error: any): boolean {
        if (!isRepeatedInvalidCodeFailure(error)) return false;
        try {
            return noteSuspiciousFailure(suspiciousFailurePayload(account, error)) === true;
        } catch {
            return false;
        }
    }
    function credentialIdentity(account: any): string {
        if (!account) return '';
        return JSON.stringify([
            String(account.refreshtoken || ''),
            String(account.loginBuffer || ''),
            Number(account.wxCredentialLastSuccessAt) || 0,
        ]);
    }
    function blockCredential(accountId: string, reason = 'definitive'): void {
        const account = findAccount(accountId);
        definitiveCredentialFailures.set(String(accountId), credentialIdentity(account));
        scheduler.clear(getKeepaliveTaskName(accountId));
        scheduler.clear(getReloginTaskName(accountId));
        scheduler.clear(getTaskName(accountId));
        if (onInvalid && account && String(account.platform || '') === 'wx') {
            try {
                Promise.resolve(onInvalid({
                    accountId: String(accountId),
                    owner: String(account.username || ''),
                    wxid: String(account.wxid || ''),
                    reason,
                })).catch(() => { /* 提醒失败不影响凭据阻断 */ });
            } catch { /* 同步异常同样吞掉 */ }
        }
    }
    function isCredentialBlocked(accountId: string): boolean {
        const key = String(accountId || '');
        if (needsWxRescan(key) === true) return true;
        if (!definitiveCredentialFailures.has(key)) return false;
        const account = findAccount(accountId);
        if (!account || credentialIdentity(account) === definitiveCredentialFailures.get(key)) return true;
        // 新扫码可能复用 refresh token，但 loginBuffer/成功时间已更新。
        definitiveCredentialFailures.delete(key);
        return false;
    }
    function normalizeConfig(accountId: string) {
        const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
        return {
            enabled: !!(cfg && cfg.enabled === true),
            intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
        };
    }

    async function requestFarmCode(account: any): Promise<string> {
        const result = await wxCredentials.issueFarmCodeForAccount(account);
        if (result && result.Success && result.Data && result.Data.code) return String(result.Data.code);
        const error: any = new Error((result && result.Message) || '进程内获取 Code 失败');
        error.definitive = !!(result && result.definitive);
        // 透传原始协议诊断字段，避免换码失败的原始错误码被 humanize 文案吞掉。
        error.rawMessage = result && result.rawMessage;
        error.wxCode = result && result.wxCode;
        error.wxStage = result && result.wxStage;
        throw error;
    }

    function refreshAccountCode(accountId: string, reason = 'timer'): Promise<boolean> {
        const key = String(accountId);
        const generation = keepaliveGeneration.get(key) || 0;
        const existing = codeRefreshes.get(key);
        if (existing && existing.generation === generation) return existing.task;
        const task = performCodeRefresh(accountId, reason);
        const entry = { generation, task };
        codeRefreshes.set(key, entry);
        return task.finally(() => {
            if (codeRefreshes.get(key) === entry) codeRefreshes.delete(key);
        });
    }

    async function performCodeRefresh(accountId: string, reason: string): Promise<boolean> {
        const key = String(accountId);
        const generation = keepaliveGeneration.get(key) || 0;
        const stillCurrent = () => (keepaliveGeneration.get(key) || 0) === generation;
        let account = findAccount(accountId);
        if (!account || !isAutoLogin(account)) return false;
        if (isCredentialBlocked(accountId)) return false;

        const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
        if (recovery && (recovery.attempts >= MAX_DAILY_RECOVERIES || recovery.failures >= MAX_CONSECUTIVE_FAILURES)) {
            addAccountLog('auto_relogin_blocked', '自动重登已熔断，请检查网络或重新扫码', account.id, account.name, { reason, ...recovery });
            return false;
        }
        if (recovery) recovery.attempts += 1;

        try {
            // 停止超过一个凭据周期后，先滚动仍可续期的长凭据；明确撤销的授权
            // 必须重新扫码。在线保活路径本身不会走到这里。
            const expiresAt = Number(account.wxCredentialExpiresAt) || 0;
            const nearExpiry = expiresAt <= 0 || expiresAt <= Date.now() + WX_KEEPALIVE_AHEAD_MAX_MS;
            if (nearExpiry && account.loginBuffer && account.refreshtoken) {
                const keptAlive = await keepCredentialAlive(account);
                if (!stillCurrent()) return false;
                if (keptAlive && !keptAlive.Success && keptAlive.definitive === true) {
                    const err: any = new Error(keptAlive.Message || '微信授权已失效，请重新扫码');
                    err.definitive = true;
                    throw err;
                }
                if (keptAlive && keptAlive.Success) account = findAccount(accountId) || account;
            }
            const code = await requestFarmCode(account);
            if (!stillCurrent()) return false;

            // 只写本轮 Code，避免旧 account 快照覆盖刚刚滚动过的长凭据。
            const previousCode = String(account.code || '');
            addOrUpdateAccount({ id: account.id, code });
            const persisted = findAccount(accountId);
            const nextAccount = persisted || { ...account, code };
            if (persisted && persisted.code === code && previousCode !== String(code)) {
                log('系统', `已更新农场 Code: ${account.name}`, { accountId: key });
            }
            const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
            if (typeof controls.restartWorker === 'function') {
                const started = await controls.restartWorker(nextAccount);
                if (started === false) throw new Error('账号启动被拒绝');
            }
            addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${account.name}`, account.id, account.name, { reason });
            log('系统', `自动刷新 Code 成功: ${account.name}`, { accountId: key, accountName: account.name, reason });
            if (recovery) recovery.failures = 0;
            definitiveCredentialFailures.delete(key);
            clearSuspiciousFailures(key);
            return true;
        } catch (err: any) {
            if (!stillCurrent()) return false;
            if (recovery) recovery.failures += 1;
            let definitive = isDefinitiveCredentialFailure(err);
            let blockReason = 'definitive';
            if (!definitive && noteRepeatedFailure(account, err)) {
                definitive = true;
                blockReason = 'repeated_-109';
            }
            if (definitive) {
                blockCredential(accountId, blockReason);
                const message = blockReason === 'repeated_-109'
                    ? '微信凭证连续多次返回 -109，请重新扫码后再继续自动登录'
                    : '微信授权已明确失效，请重新扫码后再继续自动登录';
                addAccountLog('auto_relogin_blocked', message, account.id, account.name, { reason: blockReason });
            }
            const rawDiag = (err && (err.rawMessage || err.wxCode != null))
                ? ` [原始: code=${err.wxCode ?? '-'} stage=${err.wxStage || '-'} ${String(err.rawMessage || '').slice(0, 120)}]`
                : '';
            addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${err && err.message ? err.message : String(err)}${rawDiag}`, account.id, account.name, { reason });
            log('错误', `自动刷新 Code 失败: ${account.name} - ${err && err.message ? err.message : String(err)}${rawDiag}`, { accountId: key, accountName: account.name, reason, wxCode: err && err.wxCode, wxStage: err && err.wxStage });
            return false;
        }
    }

    /** 只滚动长凭据；不申请 Code、不启动 Worker，避免周期性掉线。 */
    function armCredentialKeepalive(accountId: string, generation: number, mode: 'online' | 'offline' = 'online'): boolean {
        const key = String(accountId || '');
        const taskName = getKeepaliveTaskName(accountId);
        scheduler.clear(taskName);
        const account = findAccount(accountId);
        if (!account || !account.loginBuffer || !account.refreshtoken) return false;
        if (!isAutoLogin(account) || isCredentialBlocked(accountId)) return false;

        let consecutiveFailures = 0;
        const scheduleNext = (reason = 'normal') => {
            if (keepaliveGeneration.get(key) !== generation) return;
            const scheduled = findAccount(accountId);
            if (!scheduled || !scheduled.loginBuffer || !scheduled.refreshtoken) return;
            const delayMs = getDelayMs(scheduled, { reason, failureCount: consecutiveFailures, now: Date.now() });
            scheduler.setTimeoutTask(taskName, delayMs, async () => {
                if (keepaliveGeneration.get(key) !== generation) return;
                const latest = findAccount(accountId);
                if (!latest || !latest.loginBuffer || !latest.refreshtoken) return;
                let nextReason = 'normal';
                try {
                    const result = await keepCredentialAlive(latest);
                    if (keepaliveGeneration.get(key) !== generation) return;
                    if (!result || !result.Success) {
                        consecutiveFailures += 1;
                        let definitive = !!(result && result.definitive === true);
                        let blockReason = 'definitive';
                        if (!definitive && noteRepeatedFailure(latest, result)) {
                            definitive = true;
                            blockReason = 'repeated_-109';
                        }
                        nextReason = definitive ? 'definitive' : 'retry';
                        if (nextReason === 'definitive') {
                            blockCredential(accountId, blockReason);
                            addAccountLog('auto_relogin_blocked', blockReason === 'repeated_-109'
                                ? '微信凭证连续多次返回 -109，请重新扫码后再继续自动登录'
                                : '微信授权已明确失效，请重新扫码后再继续自动登录', latest.id, latest.name, { reason: blockReason });
                        }
                        const stateLabel = mode === 'offline' ? '断线等待期间' : '当前游戏连接不重启';
                        const codeTag = result && (result.wxCode !== null && result.wxCode !== undefined)
                            ? ` [wxCode=${result.wxCode}${result.wxStage ? ' stage=' + result.wxStage : ''}]` : '';
                        log('错误', `微信凭证保活失败（${stateLabel}）: ${latest.name} - ${(result && result.Message) || '未知错误'}${codeTag}`, {
                            accountId: key,
                            wxCode: result && result.wxCode,
                            wxStage: result && result.wxStage,
                            definitive,
                            reason: blockReason,
                        });
                    } else {
                        consecutiveFailures = 0;
                        clearSuspiciousFailures(key);
                    }
                } catch (error: any) {
                    if (keepaliveGeneration.get(key) !== generation) return;
                    consecutiveFailures += 1;
                    let definitive = isDefinitiveCredentialFailure(error);
                    let blockReason = 'definitive';
                    if (!definitive && noteRepeatedFailure(latest, error)) {
                        definitive = true;
                        blockReason = 'repeated_-109';
                    }
                    nextReason = definitive ? 'definitive' : 'retry';
                    if (nextReason === 'definitive') {
                        blockCredential(accountId, blockReason);
                        addAccountLog('auto_relogin_blocked', blockReason === 'repeated_-109'
                            ? '微信凭证连续多次返回 -109，请重新扫码后再继续自动登录'
                            : '微信授权已明确失效，请重新扫码后再继续自动登录', latest.id, latest.name, { reason: blockReason });
                    }
                    log('错误', `微信凭证保活异常（${nextReason === 'definitive' ? '等待重新授权' : '将受控重试'}）: ${latest.name}`, { accountId: key, reason: blockReason });
                } finally {
                    // 明确失效后不再排程，只能由重新扫码恢复。
                    if (nextReason !== 'definitive') scheduleNext(nextReason);
                }
            });
        };
        scheduleNext();
        logEnableNotice('keepalive', key, `微信登录凭据${mode === 'offline' ? '断线等待保活' : '在线保活'}已启用: ${account.name}，按有效期提前 35-45 分钟续期（不换游戏 Code）`, { accountId: key, accountName: account.name, mode });
        return true;
    }

    function armOfflineCredentialKeepalive(accountId: string): boolean {
        const key = String(accountId || '');
        const generation = (keepaliveGeneration.get(key) || 0) + 1;
        keepaliveGeneration.set(key, generation);
        return armCredentialKeepalive(accountId, generation, 'offline');
    }

    function scheduleAccount(accountId: string): void {
        const key = String(accountId || '');
        const generation = (keepaliveGeneration.get(key) || 0) + 1;
        keepaliveGeneration.set(key, generation);
        const cfg = normalizeConfig(key);
        scheduler.clear(getTaskName(key));
        scheduler.clear(getKeepaliveTaskName(key));
        scheduler.clear(getReloginTaskName(key));

        const account = findAccount(key);
        if (account && !isAutoLogin(account)) { clearEnableNotices(key); return; }
        if (account && isCredentialBlocked(key)) {
            log('系统', `微信授权已失效，等待重新扫码后再登录: ${account.name}`, { accountId: key });
            return;
        }
        if (!account || !String(account.wxid || '').trim()) return;

        armCredentialKeepalive(key, generation, 'online');
        if (cfg.enabled) {
            logEnableNotice('recovery', key, `断线自动恢复已启用: ${account.name}，失败后约 ${cfg.intervalMinutes} 分钟重试`, { accountId: key, accountName: account.name });
        } else {
            enableNotices.delete(`${key}:recovery`);
        }
    }

    function rescheduleAll(): void {
        scheduler.clearAll();
        const data = getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        for (const account of accounts) scheduleAccount(account.id);
    }

    function stopAccount(accountId: string): void {
        clearEnableNotices(String(accountId));
        const key = String(accountId || '');
        keepaliveGeneration.set(key, (keepaliveGeneration.get(key) || 0) + 1);
        scheduler.clear(getTaskName(key));
        scheduler.clear(getKeepaliveTaskName(key));
        scheduler.clear(getReloginTaskName(key));
    }

    function invalidateCredentialTasks(accountId: string): void {
        const key = String(accountId);
        credentialGeneration.set(key, (credentialGeneration.get(key) || 0) + 1);
        stopAccount(key);
    }

    function scheduleRelogin(accountId: string, reason = 'offline'): boolean {
        const cfg = normalizeConfig(accountId);
        if (!cfg.enabled) return false;
        const account = findAccount(accountId);
        if (!account || !account.loginBuffer || !isAutoLogin(account) || isCredentialBlocked(accountId)) return false;
        const recovery = getRecoveryState(accountId);
        if (recovery.attempts >= MAX_DAILY_RECOVERIES || recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
            addAccountLog('auto_relogin_blocked', '自动重登次数已达上限，请检查网络或重新扫码', account.id, account.name, { reason, ...recovery });
            return false;
        }
        const key = String(accountId);
        const taskName = getReloginTaskName(key);
        const isKickout = String(reason).startsWith('kickout:');
        const kickCfg = store.getKickoutRelogin ? store.getKickoutRelogin(accountId) : null;
        const delayMs = isKickout
            ? resolveKickoutDelayMs(kickCfg, recovery.attempts)
            : cfg.intervalMinutes * 60000;
        scheduler.clear(taskName);
        scheduler.setTimeoutTask(taskName, delayMs, () => {
            const generation = keepaliveGeneration.get(key) || 0;
            const stillCurrent = () => (keepaliveGeneration.get(key) || 0) === generation;
            Promise.resolve(refreshAccountCode(accountId, reason)).then((ok) => {
                if (!ok && stillCurrent() && !isCredentialBlocked(accountId)) scheduleRelogin(accountId, reason);
            }).catch(() => {
                if (stillCurrent() && !isCredentialBlocked(accountId)) scheduleRelogin(accountId, reason);
            });
        });
        armOfflineCredentialKeepalive(accountId);
        log('系统', `账号 ${account.name} 将在 ${Math.round(delayMs / 60000)} 分钟后自动刷新凭证并重登`, { accountId: key, accountName: account.name, reason });
        return true;
    }

    function scheduleKickoutRelogin(accountId: string, reason = 'kickout'): boolean {
        return scheduleRelogin(accountId, reason.startsWith('kickout:') ? reason : `kickout:${reason}`);
    }

    return {
        invalidateCredentialTasks,
        refreshAccountCode,
        isCredentialBlocked,
        scheduleAccount,
        rescheduleAll,
        stopAccount,
        scheduleRelogin,
        scheduleKickoutRelogin,
        resolveKickoutDelayMs,
        getTaskNames: () => scheduler.getTaskNames(),
    };
}

module.exports = {
    createAutoCodeRefreshService,
    nextCredentialKeepaliveDelayMs,
    reloginDelayMs,
    resolveKickoutDelayMs,
};
