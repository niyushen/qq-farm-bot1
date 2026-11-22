export {};
const path = require('node:path');
const fs = require('node:fs');
const { getSystemDateKey } = require('../utils/utils');
function getStatsFilePath(accountId: string): string {
    const dataDir: string = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
    return path.join(dataDir, 'stats', `${accountId}.json`);
}

function getTodayKey(): string {
    return getSystemDateKey();
}

function loadPersistedStats(accountId: string): any {
    try {
        const filePath: string = getStatsFilePath(accountId);
        if (!fs.existsSync(filePath)) return null;
        const raw: string = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function savePersistedStats(accountId: string, data: any): void {
    try {
        const filePath: string = getStatsFilePath(accountId);
        const dir: string = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath: string = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch {
        // ignore
    }
}

interface OperationsMap {
    [key: string]: number;
    harvest: number;
    water: number;
    weed: number;
    bug: number;
    farming: number;
    fertilize: number;
    plant: number;
    steal: number;
    helpFarming: number;
    helpWater: number;
    goldenBugClear: number;
    goldenBugPut: number;
    helpWeed: number;
    helpBug: number;
    taskClaim: number;
    sell: number;
    upgrade: number;
    levelUp: number;
    tongQiGift: number;
}

const operations: OperationsMap = {
    harvest: 0,
    water: 0,
    weed: 0,
    bug: 0,
    farming: 0,
    fertilize: 0,
    plant: 0,
    steal: 0,
    helpFarming: 0,
    helpWater: 0,
    goldenBugClear: 0,
    goldenBugPut: 0,
    helpWeed: 0,
    helpBug: 0,
    taskClaim: 0,
    sell: 0,
    upgrade: 0,
    levelUp: 0,
    tongQiGift: 0,
};

/** 全期累计操作计数（跨天不重置，供「账号统计」卡片展示） */
const totalOperations: Record<string, number> = {};

let currentDateKey: string | null = null;

interface LastState {
    gold: number;
    exp: number;
    coupon: number;
    goldBean: number;
}

const lastState: LastState = {
    gold: -1,
    exp: -1,
    coupon: -1,
    goldBean: -1,
};

interface InitialState {
    gold: number | null;
    exp: number | null;
    coupon: number | null;
    goldBean: number | null;
}

const initialState: InitialState = {
    gold: null,
    exp: null,
    coupon: null,
    goldBean: null,
};

interface SessionData {
    goldGained: number;
    expGained: number;
    couponGained: number;
    goldBeanGained: number;
    lastExpGain: number;
    lastGoldGain: number;
    lastExpTime?: number;
}

const session: SessionData = {
    goldGained: 0,
    expGained: 0,
    couponGained: 0,
    goldBeanGained: 0,
    lastExpGain: 0,
    lastGoldGain: 0,
};

/** 「今日增加」基线：按系统时区日期记录首次观测到的余额，跨重启在同日内保留。 */
interface DailyBaseline {
    date: string | null;
    values: Record<string, number>;
}

const dailyBaseline: DailyBaseline = { date: null, values: {} };

/**
 * 「今日增加收入」：只累加金币的正向变化，忽略升级/购买等花费导致的下降。
 * 与 todayGoldGained（余额首尾净值）口径不同，此值只增不减，跨天重置、同日重启保留。
 */
const dailyGoldEarned: { date: string | null, value: number } = { date: null, value: 0 };

/** 离线时复用最后一次在线计算出的今日增量，避免用登录前的 0 余额污染基线。 */
const lastDailyGains = { exp: 0, gold: 0, coupon: 0, goldBean: 0 };

/** 「本次增加」基线：牧场等按需读取的资产在本次会话首次读取时记录。 */
const sessionAssets: Record<string, number> = {};

let currentAccountId: string | null = null;
let sessionStartedAt = Date.now();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function recordOperation(type: string, count: number = 1): void {
    checkAndResetDailyStats();
    if (operations[type] !== undefined) {
        operations[type] += count;
        totalOperations[type] = (totalOperations[type] || 0) + count;
        scheduleSave();
    }
}

function checkAndResetDailyStats(): void {
    if (!currentAccountId) return;
    const todayKey: string = getTodayKey();
    if (currentDateKey && currentDateKey !== todayKey) {
        console.warn(`[统计] 检测到跨天，重置每日统计 (${currentDateKey} -> ${todayKey})`);
        Object.keys(operations).forEach((key: string) => {
            operations[key] = 0;
        });
        dailyBaseline.date = todayKey;
        dailyBaseline.values = {};
        dailyGoldEarned.date = todayKey;
        dailyGoldEarned.value = 0;
        scheduleSave();
    }
    currentDateKey = todayKey;
    if (dailyBaseline.date !== todayKey) {
        dailyBaseline.date = todayKey;
        dailyBaseline.values = {};
        scheduleSave();
    }
    if (dailyGoldEarned.date !== todayKey) {
        dailyGoldEarned.date = todayKey;
        dailyGoldEarned.value = 0;
    }
}

/** 取当日增量；首次观测某资产时以当前余额为基线，返回 0。 */
function getDailyGain(key: string, current: number): number {
    const todayKey: string = getTodayKey();
    if (dailyBaseline.date !== todayKey) {
        dailyBaseline.date = todayKey;
        dailyBaseline.values = {};
        scheduleSave();
    }
    if (dailyBaseline.values[key] === undefined) {
        dailyBaseline.values[key] = current;
        scheduleSave();
        return 0;
    }
    return current - dailyBaseline.values[key];
}

/**
 * 计算牧场货币的本次/今日增量。
 * 本次基线在会话内首次读取时建立，今日基线同日跨重启保留。
 */
function getRanchAssetGains(currencies: any[]): Record<string, { sessionGained: number, todayGained: number }> {
    checkAndResetDailyStats();
    const result: Record<string, { sessionGained: number, todayGained: number }> = {};
    for (const item of (Array.isArray(currencies) ? currencies : [])) {
        const id = String(item && item.id !== undefined && item.id !== null ? item.id : '');
        const current: number = Number(item && item.count);
        if (!id || !Number.isFinite(current)) continue;
        const key = `ranch:${id}`;
        if (sessionAssets[key] === undefined) sessionAssets[key] = current;
        result[id] = {
            sessionGained: current - sessionAssets[key],
            todayGained: getDailyGain(key, current),
        };
    }
    return result;
}

function scheduleSave(): void {
    if (!currentAccountId) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        doSave();
    }, 2000);
}

function doSave(): void {
    if (!currentAccountId) return;
    const todayKey: string = getTodayKey();
    const data: any = {
        date: todayKey,
        operations: { ...operations },
        totalOperations: { ...totalOperations },
        initialState: { ...initialState },
        dailyBaseline: { date: dailyBaseline.date, values: { ...dailyBaseline.values } },
        dailyGoldEarned: { date: dailyGoldEarned.date, value: dailyGoldEarned.value },
        // 上次在线观测到的金币余额：重连后据此补记离线期间的正向收入
        lastObservedGold: lastState.gold,
        savedAt: Date.now(),
    };
    savePersistedStats(currentAccountId, data);
}

function initStats(gold: number, exp: number, coupon: number = 0, goldBean: number = 0): void {
    sessionStartedAt = Date.now();
    const g: number = Number.isFinite(Number(gold)) ? Number(gold) : 0;
    const e: number = Number.isFinite(Number(exp)) ? Number(exp) : 0;
    const c: number = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
    const b: number = Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0;
    lastState.gold = g;
    lastState.exp = e;
    lastState.coupon = c;
    lastState.goldBean = b;
    initialState.gold = g;
    initialState.exp = e;
    initialState.coupon = c;
    initialState.goldBean = b;
    Object.keys(sessionAssets).forEach((key: string) => { delete sessionAssets[key]; });
}

function initStatsWithPersistence(accountId: string, gold: number, exp: number, coupon: number = 0, goldBean: number = 0): void {
    currentAccountId = accountId;
    const todayKey: string = getTodayKey();
    currentDateKey = todayKey;
    const saved: any = loadPersistedStats(accountId);

    if (saved && saved.date === todayKey) {
        Object.keys(saved.operations || {}).forEach((key: string) => {
            if (operations[key] !== undefined) {
                operations[key] = Number(saved.operations[key]) || 0;
            }
        });
        console.warn(`[统计] 已恢复今日统计数据: ${JSON.stringify(saved.operations)}`);
    } else {
        Object.keys(operations).forEach((key: string) => {
            operations[key] = 0;
        });
        if (saved) {
            console.warn(`[统计] 日期已变更，重置统计 (${saved.date} -> ${todayKey})`);
        }
    }

    // 「今日增加」基线：同日重启后沿用已保存的首次余额，跨日则重新建立
    if (saved && saved.date === todayKey && saved.dailyBaseline && saved.dailyBaseline.date === todayKey && saved.dailyBaseline.values && typeof saved.dailyBaseline.values === 'object') {
        dailyBaseline.date = todayKey;
        dailyBaseline.values = { ...saved.dailyBaseline.values };
    } else {
        dailyBaseline.date = todayKey;
        dailyBaseline.values = {};
    }

    // 今日增加收入（只计正向）：同日重启恢复累计值，跨日重新从 0 开始
    if (saved && saved.date === todayKey && saved.dailyGoldEarned && saved.dailyGoldEarned.date === todayKey) {
        dailyGoldEarned.date = todayKey;
        const restored: number = Number(saved.dailyGoldEarned.value);
        dailyGoldEarned.value = Number.isFinite(restored) && restored > 0 ? restored : 0;
    } else {
        dailyGoldEarned.date = todayKey;
        dailyGoldEarned.value = 0;
    }

    // 全期累计跨天不重置：无论是否同一天都恢复
    const savedTotals: any = saved && saved.totalOperations && typeof saved.totalOperations === 'object' ? saved.totalOperations : {};
    Object.keys(savedTotals).forEach((key: string) => {
        totalOperations[key] = Number(savedTotals[key]) || 0;
    });

    initStats(gold, exp, coupon, goldBean);

    // 离线期间的正向收入补记：
    // initStats 刚把 lastState.gold 设为登录瞬间的余额，直接用它会跳过离线涨跌。
    // 同日重启时改用持久化的「上次在线观测余额」作为增量起点，这样登录后的首次
    // updateStats 会把离线期间的正向增加累加进 todayGoldEarned，花费（下降）仍忽略。
    if (saved && saved.date === todayKey && Number.isFinite(Number(saved.lastObservedGold))) {
        lastState.gold = Number(saved.lastObservedGold);
    }
}

function updateStats(currentGold: number, currentExp: number): void {
    if (lastState.gold === -1) lastState.gold = currentGold;
    if (lastState.exp === -1) lastState.exp = currentExp;

    const todayKey: string = getTodayKey();
    if (dailyGoldEarned.date !== todayKey) {
        dailyGoldEarned.date = todayKey;
        dailyGoldEarned.value = 0;
    }

    if (currentGold > lastState.gold) {
        const delta: number = currentGold - lastState.gold;
        session.lastGoldGain = delta;
        // 只计增加量：金币上升即累加，升级/购买等导致的下降忽略，不冲减当日收入。
        dailyGoldEarned.value += delta;
        scheduleSave();
    } else if (currentGold < lastState.gold) {
        session.lastGoldGain = 0;
    }
    lastState.gold = currentGold;

    if (currentExp > lastState.exp) {
        const delta: number = currentExp - lastState.exp;
        const now: number = Date.now();
        if (delta === session.lastExpGain && (now - (session.lastExpTime || 0) < 1000)) {
            // console.warn(`[系统] 忽略重复经验增量 +${delta}`);
        } else {
            session.lastExpGain = delta;
            session.lastExpTime = now;
            // console.warn(`[系统] 经验 +${delta} (总计: ${currentExp})`);
        }
    } else {
        session.lastExpGain = 0;
    }
    lastState.exp = currentExp;
}

function recordGoldExp(gold: number, exp: number): void {
    updateStats(gold, exp);
}

function setInitialValues(gold: number, exp: number, coupon: number = 0, goldBean: number = 0): void {
    initStats(gold, exp, coupon, goldBean);
}

function resetSessionGains(): void {
    session.goldGained = 0;
    session.expGained = 0;
    session.couponGained = 0;
    session.goldBeanGained = 0;
    session.lastGoldGain = 0;
    session.lastExpGain = 0;
    session.lastExpTime = 0;
}

function recomputeSessionTotals(currentGold: number, currentExp: number, currentCoupon: number, currentGoldBean: number): void {
    if (initialState.gold === null || initialState.exp === null || initialState.coupon === null || initialState.goldBean === null) {
        initialState.gold = currentGold;
        initialState.exp = currentExp;
        initialState.coupon = currentCoupon;
        initialState.goldBean = currentGoldBean;
    }
    session.goldGained = currentGold - (initialState.gold as number);
    session.expGained = currentExp - (initialState.exp as number);
    session.couponGained = currentCoupon - (initialState.coupon as number);
    session.goldBeanGained = currentGoldBean - (initialState.goldBean as number);
}

function getStats(statusData: any, userState: any, connected: boolean, limits: any): any {
    checkAndResetDailyStats();
    const statusObj: any = (statusData && typeof statusData === 'object') ? statusData : {};
    const userObj: any = (userState && typeof userState === 'object') ? userState : {};

    const rawGold: any = userObj.gold ?? statusObj.gold;
    const rawExp: any = userObj.exp ?? statusObj.exp;
    const rawCoupon: any = userObj.coupon ?? statusObj.coupon;
    const rawGoldBean: any = userObj.goldBean ?? statusObj.goldBean;
    const currentGold: number = Number.isFinite(Number(rawGold)) ? Number(rawGold) : 0;
    const currentExp: number = Number.isFinite(Number(rawExp)) ? Number(rawExp) : 0;
    const currentCoupon: number = Number.isFinite(Number(rawCoupon)) ? Number(rawCoupon) : 0;
    const currentGoldBean: number = Number.isFinite(Number(rawGoldBean)) ? Number(rawGoldBean) : 0;

    if (connected) {
        updateStats(currentGold, currentExp);
        recomputeSessionTotals(currentGold, currentExp, currentCoupon, currentGoldBean);
        lastDailyGains.exp = getDailyGain('exp', currentExp);
        lastDailyGains.gold = getDailyGain('gold', currentGold);
        lastDailyGains.coupon = getDailyGain('coupon', currentCoupon);
        lastDailyGains.goldBean = getDailyGain('goldBean', currentGoldBean);
    }

    const operationsSnapshot: OperationsMap = { ...operations };
    return {
        connection: { connected },
        status: {
            name: userObj.name || statusObj.name,
            level: statusObj.level || userObj.level || 0,
            gold: currentGold,
            coupon: Number.isFinite(Number(userObj.coupon)) ? Number(userObj.coupon) : 0,
            goldBean: currentGoldBean,
            exp: currentExp,
            platform: statusObj.platform || userObj.platform || 'qq',
            avatarUrl: String(userObj.avatarUrl || statusObj.avatarUrl || '').trim(),
        },
        uptime: process.uptime(),
        sessionElapsedSeconds: Math.max(0, (Date.now() - sessionStartedAt) / 1000),
        operations: operationsSnapshot,
        operationsTotal: { ...totalOperations },
        sessionExpGained: session.expGained,
        sessionGoldGained: session.goldGained,
        sessionCouponGained: session.couponGained,
        sessionGoldBeanGained: session.goldBeanGained,
        todayExpGained: lastDailyGains.exp,
        todayGoldGained: lastDailyGains.gold,
        // 今日收入：只累加正向增加，忽略升级/购买等花费（与个人页、排行榜口径一致）
        todayGoldEarned: dailyGoldEarned.value,
        todayCouponGained: lastDailyGains.coupon,
        todayGoldBeanGained: lastDailyGains.goldBean,
        lastExpGain: session.lastExpGain,
        lastGoldGain: session.lastGoldGain,
        limits,
    };
}

function saveStats(): void {
    doSave();
}

module.exports = {
    recordOperation,
    initStats,
    initStatsWithPersistence,
    updateStats,
    setInitialValues,
    recordGoldExp,
    resetSessionGains,
    getStats,
    saveStats,
    getTodayKey,
    loadPersistedStats,
    checkAndResetDailyStats,
    getRanchAssetGains,
};
