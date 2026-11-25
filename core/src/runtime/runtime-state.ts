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

/**
 * 事件名别名表：后端产出的 event 中英文混用（同一语义两种写法），
 * 前端筛选项历史上用英文 code、日志实际用中文名。
 * 这里登记互认关系，使「按英文筛选项筛选」能命中中文日志，反之亦然。
 * key 与 value 都可作为筛选目标，两者互相命中。
 */
const LOG_EVENT_ALIASES: Record<string, string[]> = {
    // —— 农场 ——
    farm_cycle: ['农场循环'],
    '农场循环': ['farm_cycle'],
    harvest_crop: ['收获作物'],
    '收获作物': ['harvest_crop'],
    remove_plant: ['铲除植物'],
    '铲除植物': ['remove_plant'],
    plant_seed: ['种植种子'],
    '种植种子': ['plant_seed'],
    seed_pick: ['选择种子'],
    '选择种子': ['seed_pick'],
    seed_buy: ['购买种子'],
    '购买种子': ['seed_buy'],
    fertilize: ['常规施肥', '多季节施肥', '手动施肥', '一键施肥'],
    '常规施肥': ['fertilize'],
    '多季节施肥': ['fertilize'],
    '手动施肥': ['fertilize'],
    '一键施肥': ['fertilize'],
    harvest_after_fertilize: ['施肥后收获作物'],
    '施肥后收获作物': ['harvest_after_fertilize'],
    lands_notify: ['土地推送通知'],
    '土地推送通知': ['lands_notify'],
    upgrade_land: ['升级土地'],
    '升级土地': ['upgrade_land'],
    unlock_land: ['解锁土地'],
    '解锁土地': ['unlock_land'],
    // —— 好友 ——
    friend_cycle: ['好友巡查循环', '开始好友巡查'],
    '好友巡查循环': ['friend_cycle'],
    '开始好友巡查': ['friend_cycle'],
    visit_friend: ['照顾好友', '进入农场'],
    '照顾好友': ['visit_friend'],
    '进入农场': ['visit_friend'],
    steal_cycle: ['偷菜巡查'],
    '偷菜巡查': ['steal_cycle'],
    // —— 仓库 ——
    // —— 任务 ——
    task_scan: ['扫描任务', '扫描活跃奖励'],
    '扫描任务': ['task_scan'],
    '扫描活跃奖励': ['task_scan'],
    task_claim: ['领取任务', '领取活跃奖励'],
    '领取任务': ['task_claim'],
    '领取活跃奖励': ['task_claim'],
    // —— 奖励 ——
    daily_share: ['daily_share'],
    vip_daily_gift: ['vip_daily_gift'],
    month_card_gift: ['month_card_gift'],
    mall_free_gifts: ['mall_free_gifts'],
    illustrated_rewards: ['图鉴奖励'],
    '图鉴奖励': ['illustrated_rewards'],
    email_rewards: ['email_rewards'],
    // —— 牧场 ——
    ranch_automation: ['ranch_automation'],
};

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
    /**
     * 统一日志池（上游 PR #184 引入）。
     *
     * 与双池同步维护：写入时两处都推入，容量为两池之和（各 LOG_POOL_LIMIT）。
     * 双池保留是因为本地按空间分配独立配额（农场/牧场各 2000 条），
     * 单池则等价上游的全局 1000 条上限 —— 容量会缩水，故两者并存。
     */
    const globalLogs: LogEntry[] = [];
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
        globalLogs.push(entry);
        if (globalLogs.length > LOG_POOL_LIMIT * 2) globalLogs.shift();
        return entry;
    }

    function log(tag: string, msg: string, extra: Record<string, any> = {}): void {
        const time = formatSystemDateTime24();
        const level = tag === '错误' ? 'error' : 'info';
        runtimeLogger[level](msg, { tag, ...extra });
        const moduleName = (tag === '系统' || tag === '错误') ? 'system' : '';
        // module / event 必须同时写进 meta：前端按 meta.event 读事件、
        // resolveLogSpace 也按 meta.event 判牧场空间。若只展开到顶层，
        // 事件筛选、二级子模块、逐块务农聚合会全部失效。
        const extraModule = String(extra.module || '').trim();
        const extraEvent = String(extra.event || '').trim();
        const meta: Record<string, any> = moduleName ? { module: moduleName } : {};
        if (extraModule) meta.module = extraModule;
        if (extraEvent) meta.event = extraEvent;
        const entry: LogEntry = {
            time,
            tag,
            msg,
            meta,
            ts: Date.now(),
            ...extra,
        };
        // extra 展开在顶层会覆盖 meta，这里确保顶层副本与 meta 一致。
        if (extraModule) entry.module = extraModule;
        if (extraEvent) entry.event = extraEvent;
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
            runExpGained: 0,
            runGoldGained: 0,
            runCouponGained: 0,
            todayExpGained: 0,
            todayGoldGained: 0,
            todayGoldEarned: 0,
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

    /**
     * 事件名匹配：后端产出的 event 中英文混用（如「农场循环」与 farm_cycle 各指一类），
     * 而前端筛选项历史上用的是英文 code。这里同时认 meta.event / 顶层 event，
     * 并支持「英文 code ↔ 中文名」互认，避免筛选项必须与日志字面完全一致。
     */
    function matchesLogEvent(entry: any, eventName: string): boolean {
        const target = String(eventName || '').trim();
        if (!target) return true;
        const candidates = [
            String((entry && entry.meta || {}).event || ''),
            String((entry && entry.event) || ''),
        ].filter(Boolean);
        if (candidates.includes(target)) return true;
        // 别名互认：同一语义的中英文写法视为同一事件
        const alias = LOG_EVENT_ALIASES[target] || [];
        return candidates.some(c => alias.includes(c));
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
                // 日志的模块信息实际落在 tag 上（meta.module 多为空），按 tag 归一化后一起匹配
                const tag = String(l.tag || '');
                const TAG_MODULE: Record<string, string> = {
                    '农场': 'farm', '好友': 'friend', '仓库': 'warehouse',
                    '牧场': 'ranch', '任务': 'task', '系统': 'system', '错误': 'system',
                    'QQ机器人': 'qqbot',
                };
                const tagModule = TAG_MODULE[tag] || '';
                const modules = moduleName.split(',').map(s => s.trim()).filter(Boolean);
                const matched = modules.some((m) => {
                    if (m === 'system')
                        return logModule === 'system' || tagModule === 'system';
                    return logModule === m || tagModule === m;
                });
                if (!matched) return false;
            }
            if (eventName && !matchesLogEvent(l, eventName)) return false;
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
        globalLogs,
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
        matchesLogEvent,
    };
}

module.exports = {
    createRuntimeState,
    LOG_POOL_LIMIT,
    LOG_EVENT_ALIASES,
};
