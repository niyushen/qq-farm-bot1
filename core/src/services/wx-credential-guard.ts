export {};
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

/**
 * 微信授权失效的持久化阻断状态（对齐 qq-farm-bot 的 needsRescan 语义）。
 *
 * 关键约束：
 * - 明确失效后写入 incidents[accountId].needsRescan，进程重启也不会复活；
 * - 只有真实接受的新扫码（noteAcceptedScan）才能推进扫码代次并清除事件；
 * - token 轮换、改备注、服务重启都不改变代次或清除事件；
 * - 外发提醒由注入回调完成，guard 本身只负责状态，回调失败不影响阻断。
 */

const REGISTRY_FILE = getDataFile('wx-credential-guard.json');

/**
 * refresh_token/login_buffer 连续返回 -109（RC_PARAMS_INVALID）时，单次可能是握手抖动；
 * 同一扫码代次内反复出现则说明凭证已不可用。达到阈值后升级为明确失效，避免账号
 * 只退避不停机、面板却一直提示“请检查网络”。成功刷新或重新扫码都会清零。
 */
const REPEATED_INVALID_TOKEN_CODE = -109;
const REPEATED_INVALID_TOKEN_THRESHOLD = 3;

function emptyRegistry(): any {
    return { generations: {}, incidents: {}, failures: {} };
}

function loadRegistry(): any {
    const data = readJsonFile(REGISTRY_FILE, emptyRegistry);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyRegistry();
    if (!data.generations || typeof data.generations !== 'object' || Array.isArray(data.generations)) data.generations = {};
    if (!data.incidents || typeof data.incidents !== 'object' || Array.isArray(data.incidents)) data.incidents = {};
    if (!data.failures || typeof data.failures !== 'object' || Array.isArray(data.failures)) data.failures = {};
    return data;
}

function saveRegistry(data: any): void {
    writeJsonFileAtomic(REGISTRY_FILE, data);
}

function currentGeneration(accountId: string): number {
    const key = String(accountId || '');
    if (!key) return 0;
    const data = loadRegistry();
    return Number(data.generations[key]) || 0;
}

function needsRescan(accountId: string): boolean {
    const key = String(accountId || '');
    if (!key) return false;
    const data = loadRegistry();
    const incident = data.incidents[key];
    return !!(incident && incident.needsRescan === true);
}

/** 只应由「新扫码被接受并保存」的路径调用；token 轮换不能推进代次。 */
function noteAcceptedScan(accountId: string): number {
    const key = String(accountId || '');
    if (!key) return 0;
    const data = loadRegistry();
    const nextGeneration = (Number(data.generations[key]) || 0) + 1;
    data.generations[key] = nextGeneration;
    delete data.incidents[key];
    delete data.failures[key];
    saveRegistry(data);
    return nextGeneration;
}

/**
 * 记录同代次内连续 -109 次数。只累计计数，不直接阻断：达到阈值后由调用方
 * 走统一的 blockCredential → noteCredentialInvalid 链路，保证提醒只发一次。
 * @returns 是否已达到升级阈值
 */
function noteSuspiciousCredentialFailure(input: any): boolean {
    const snapshot = input && typeof input === 'object' ? input : { accountId: input };
    const key = String(snapshot.accountId || '');
    if (!key) return false;
    const code = Number(snapshot.code ?? snapshot.wxCode);
    if (code !== REPEATED_INVALID_TOKEN_CODE) return false;

    const data = loadRegistry();
    const generation = Number(data.generations[key]) || 0;
    const previous = data.failures[key];
    const sameGeneration = !!previous && Number(previous.generation) === generation;
    const count = (sameGeneration ? Number(previous.count) || 0 : 0) + 1;
    data.failures[key] = {
        generation,
        code: REPEATED_INVALID_TOKEN_CODE,
        stage: String(snapshot.stage || ''),
        count,
        firstSeenAt: sameGeneration ? Number(previous.firstSeenAt) || Date.now() : Date.now(),
        lastSeenAt: Date.now(),
    };
    saveRegistry(data);
    return count >= REPEATED_INVALID_TOKEN_THRESHOLD;
}

/** 成功续期、人工恢复或清除事件时重置连续失败计数。 */
function clearSuspiciousCredentialFailures(accountId: string): void {
    const key = String(accountId || '');
    if (!key) return;
    const data = loadRegistry();
    if (!data.failures[key]) return;
    delete data.failures[key];
    saveRegistry(data);
}

/**
 * 凭据被明确判定失效时调用。写入 needsRescan 后同代次只触发一次提醒回调。
 */
function noteCredentialInvalid(input: any, onInvalid?: (payload: any) => Promise<void> | void): boolean {
    const snapshot = input && typeof input === 'object' ? input : { accountId: input };
    const key = String(snapshot.accountId || '');
    if (!key) return false;
    const data = loadRegistry();
    const generation = Number(data.generations[key]) || 0;
    const incident = data.incidents[key];
    if (incident && Number(incident.generation) === generation && incident.needsRescan === true) {
        return false;
    }
    data.incidents[key] = {
        generation,
        needsRescan: true,
        firstSeenAt: Number(incident && incident.firstSeenAt) || Date.now(),
        claimedAt: Date.now(),
        owner: String(snapshot.owner || ''),
        wxid: String(snapshot.wxid || ''),
    };
    delete data.failures[key];
    // 先落盘再外发（fail closed）：状态没写成功就不声明已提醒。
    saveRegistry(data);
    if (typeof onInvalid === 'function') {
        try {
            Promise.resolve(onInvalid({ ...snapshot, accountId: key, generation })).catch(() => { /* 提醒失败不影响阻断 */ });
        } catch { /* 同步异常同样吞掉 */ }
    }
    return true;
}

function clearIncident(accountId: string): void {
    const key = String(accountId || '');
    if (!key) return;
    const data = loadRegistry();
    delete data.incidents[key];
    delete data.failures[key];
    saveRegistry(data);
}

module.exports = {
    REGISTRY_FILE,
    REPEATED_INVALID_TOKEN_CODE,
    REPEATED_INVALID_TOKEN_THRESHOLD,
    clearIncident,
    clearSuspiciousCredentialFailures,
    currentGeneration,
    needsRescan,
    noteAcceptedScan,
    noteCredentialInvalid,
    noteSuspiciousCredentialFailure,
};
