export {};
const { EventEmitter } = require('node:events');
const { getRuntimeConfig } = require('../config/config');
const { createModuleLogger } = require('../services/logger');
const { getTodayKey, loadPersistedStats } = require('../services/stats');
const { formatSystemDateTime24, resolveLogSpace } = require('../utils/utils');

interface RuntimeStateOptions {
    store: any;
    operationKeys?: string[];
}

interface LogEntry {
    time: string;
    tag: string;
    msg: string;
    meta: Record<string, any>;
    ts: number;
    /** 所属空间：ranch=牧场 / farm=农场（其余全部农场），由 appendLog 打标 */
    space?: string;
    _searchText?: string;
    [key: string]: any;
}

interface AccountLogEntry {
    time: string;
    action: string;
    msg: string;
    accountId: string;
    accountName: string;
    [key: string]: any;
}

interface LogFilters {
    keyword?: string;
    tag?: string;
    module?: string;
    event?: string;
    isWarn?: boolean | string;
    timeFrom?: string;
    timeTo?: string;
}

/** 每个空间日志池的独立上限（条）；牧场池与农场池各自计数、各自截断 */
const LOG_POOL_LIMIT = 2000;

function createRuntimeState(options: RuntimeStateOptions) {
    const {
        store,
        operationKeys = [],
    } = options;

    const workers: Record<string, any> = {};
    /**
     * 运行日志池：按空间拆分。
     * farm = 全部非牧场日志（农场/好友/仓库/任务/系统），ranch = 牧场日志。
     * 两个数组物理独立；写入只能经 appendLog。
     */
    const logPools: { farm: LogEntry[]; ranch: LogEntry[] } = { farm: [], ranch: [] };
    const accountLogs: AccountLogEntry[] = [];
    const runtimeEvents = new EventEmitter();
    let configRevision = Date.now();
    const runtimeLogger = createModuleLogger('runtime');

    function nextConfigRevision(): number {
        configRevision += 1;
        return configRevision;
    }

    function buildConfigSnapshotForAccount(accountId: string): any {
        const { ui: _ui, ...accountConfig } = store.getConfigSnapshot(accountId);
        return {
            ...accountConfig,
            systemTimeZone: getRuntimeConfig().timeZone,
            systemServerUrl: getRuntimeConfig().serverUrl,
            systemClientVersion: getRuntimeConfig().clientVersion,
            systemWxClientVersion: getRuntimeConfig().wxClientVersion,
            systemDeviceInfo: getRuntimeConfig().deviceInfo,
            __revision: configRevision,
        };
    }

    /**
     * 唯一的运行日志写入口：
     * 1) 判定空间并写入 entry.space（前端据此分流，WS payload 天然携带）
     * 2) 推入对应空间的池
     * 3) 该池独立按 LOG_POOL_LIMIT 截断
     */
    function appendLog(entry: LogEntry): LogEntry {
        const space = resolveLogSpace(entry);
        entry.space = space;
        const pool = logPools[space] || logPools.farm;
        pool.push(entry);
        if (pool.length > LOG_POOL_LIMIT) pool.shift();
        return entry;
    }

    function log(tag: string, msg: string, extra: Record<string, any> = {}): void {
        const time = formatSystemDateTime24();
        const level = tag === '错误' ? 'error' : 'info';
        runtimeLogger[level](msg, { tag, ...extra });
        const moduleName = (tag === '系统' || tag === '错误') ? 'system' : '';
        const entry: LogEntry = {
            time,
            tag,
            msg,
            meta: moduleName ? { module: moduleName } : {},
            ts: Date.now(),
            ...extra,
        };
        entry._searchText = `${entry.msg || ''} ${entry.tag || ''} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
        appendLog(entry);
        runtimeEvents.emit('log', entry);
    }

    function addAccountLog(action: string, msg: string, accountId = '', accountName = '', extra: Record<string, any> = {}): void {
        const entry: AccountLogEntry = {
            time: formatSystemDateTime24(),
            action,
            msg,
            accountId: accountId ? String(accountId) : '',
            accountName: accountName || '',
            ...extra,
        };
        accountLogs.push(entry);
        if (accountLogs.length > 300) accountLogs.shift();
        runtimeEvents.emit('account_log', entry);
    }

    function normalizeStatusForPanel(data: any, accountId: string, accountName: string): any {
        const src = (data && typeof data === 'object') ? data : {};
        const ops = (src.operations && typeof src.operations === 'object') ? { ...src.operations } : {};
        for (const k of operationKeys) {
            if (ops[k] === undefined || ops[k] === null || Number.isNaN(Number(ops[k]))) {
                ops[k] = 0;
            } else {
                ops[k] = Number(ops[k]);
            }
        }
        // 全期累计：透传并规范数值（缺失键由前端按 0 展示）
        const opsTotalSrc = (src.operationsTotal && typeof src.operationsTotal === 'object') ? src.operationsTotal : {};
        const opsTotal: Record<string, number> = {};
        for (const k of operationKeys) {
            opsTotal[k] = Number(opsTotalSrc[k]) || 0;
        }
        return {
            ...src,
            accountId,
            accountName,
            operations: ops,
            operationsTotal: opsTotal,
        };
    }

    function buildDefaultOperations(): Record<string, number> {
        const ops: Record<string, number> = {};
        for (const k of operationKeys) ops[k] = 0;
        return ops;
    }

    function buildDefaultStatus(accountId: string): any {
        const id = String(accountId || '');
        const operations = buildDefaultOperations();
        const operationsTotal: Record<string, number> = {};
        let totalSteal = 0;

        if (id) {
            const saved = loadPersistedStats(id);
            const todayKey = getTodayKey();
            if (saved) {
                if (saved.date === todayKey && saved.operations) {
                    for (const k of operationKeys) {
                        if (saved.operations[k] !== undefined) {
                            operations[k] = Number(saved.operations[k]) || 0;
                        }
                    }
                }
                if (typeof saved.totalSteal === 'number') {
                    totalSteal = saved.totalSteal;
                }
                // 全期累计跨天不重置
                if (saved.totalOperations && typeof saved.totalOperations === 'object') {
                    Object.keys(saved.totalOperations).forEach((k: string) => {
                        operationsTotal[k] = Number(saved.totalOperations[k]) || 0;
                    });
                }
            }
        }

        return {
            connection: { connected: false },
            status: { name: '', level: 0, gold: 0, exp: 0, platform: 'qq' },
            uptime: 0,
            operations,
            operationsTotal,
            totalSteal,
            sessionExpGained: 0,
            sessionGoldGained: 0,
            sessionCouponGained: 0,
            sessionGoldBeanGained: 0,
            todayExpGained: 0,
            todayGoldGained: 0,
            todayCouponGained: 0,
            todayGoldBeanGained: 0,
            lastExpGain: 0,
            lastGoldGain: 0,
            limits: {},
            wsError: null,
            automation: store.getAutomation(accountId),
            preferredSeed: store.getPreferredSeed(accountId),
            expProgress: { current: 0, needed: 0, level: 0 },
            configRevision,
            accountId: id,
        };
    }

    function filterLogs(list: LogEntry[], filters: LogFilters = {}): LogEntry[] {
        const f = filters || {};
        const keyword = String(f.keyword || '').trim().toLowerCase();
        const keywordTerms = keyword ? keyword.split(/\s+/).filter(Boolean) : [];
        const tag = String(f.tag || '').trim();
        const moduleName = String(f.module || '').trim();
        const eventName = String(f.event || '').trim();
        const isWarn = f.isWarn;
        const timeFromMs = f.timeFrom ? Date.parse(String(f.timeFrom)) : Number.NaN;
        const timeToMs = f.timeTo ? Date.parse(String(f.timeTo)) : Number.NaN;
        return (list || []).filter((l) => {
            const logMs = Number(l && l.ts) || Date.parse(String((l && l.time) || ''));
            if (Number.isFinite(timeFromMs) && Number.isFinite(logMs) && logMs < timeFromMs) return false;
            if (Number.isFinite(timeToMs) && Number.isFinite(logMs) && logMs > timeToMs) return false;
            if (tag && String(l.tag || '') !== tag) return false;
            if (moduleName) {
                const logModule = String((l.meta || {}).module || '');
                if (moduleName === 'system') {
                    const isSystemTag = String(l.tag || '') === '系统' || String(l.tag || '') === '错误';
                    if (logModule !== 'system' && !isSystemTag) return false;
                } else if (logModule !== moduleName) {
                    return false;
                }
            }
            if (eventName && String((l.meta || {}).event || '') !== eventName) return false;
            if (isWarn !== undefined && isWarn !== null && String(isWarn) !== '') {
                const expected = String(isWarn) === '1' || String(isWarn).toLowerCase() === 'true';
                if (!!l.isWarn !== expected) return false;
            }
            if (keywordTerms.length > 0) {
                const text = String(l._searchText || `${l.msg || ''} ${l.tag || ''}`).toLowerCase();
                for (const term of keywordTerms) {
                    if (!text.includes(term)) return false;
                }
            }
            return true;
        });
    }

    return {
        workers,
        logPools,
        appendLog,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    };
}

module.exports = {
    createRuntimeState,
    LOG_POOL_LIMIT,
};
