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

function emptyRegistry(): any {
    return { generations: {}, incidents: {} };
}

function loadRegistry(): any {
    const data = readJsonFile(REGISTRY_FILE, emptyRegistry);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyRegistry();
    if (!data.generations || typeof data.generations !== 'object' || Array.isArray(data.generations)) data.generations = {};
    if (!data.incidents || typeof data.incidents !== 'object' || Array.isArray(data.incidents)) data.incidents = {};
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
    saveRegistry(data);
    return nextGeneration;
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
    saveRegistry(data);
}

module.exports = {
    REGISTRY_FILE,
    clearIncident,
    currentGeneration,
    needsRescan,
    noteAcceptedScan,
    noteCredentialInvalid,
};
