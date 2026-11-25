import type { MapleMarketQuote } from './maple-market';

export {};

const { BackgroundJob } = require('../app/background-job');
const { submitAccountTask } = require('../app/account-task-runner');
const { createExecutionScope, runWithExecutionScope } = require('../utils/execution-scope');
const { getUserState, networkEvents } = require('../utils/network');
const { formatDateKeyInTimeZone, getServerTimeSec } = require('../utils/utils');
const { getFriendsList, getFriendsListStatus } = require('./friend/visit-strategy');
const { getMarketProgress, getShopQuote, sellMapleMarketCrop } = require('./maple-market');

interface FriendShop {
    gid: number;
    name: string;
}

interface FriendShopResult extends FriendShop {
    quote: MapleMarketQuote | null;
    failed: boolean;
    reused: boolean;
}

interface Comparison {
    status: 'idle' | 'running' | 'ready' | 'failed';
    dayKey: string;
    total: number;
    checked: number;
    reused: number;
    queried: number;
    partial: boolean;
    updatedAt: number;
    rows: FriendShopResult[];
    error: string;
}

const BATCH_SIZE = 10;
const GAME_DAY_TIME_ZONE = 'Asia/Shanghai';
const job = new BackgroundJob();
const dayCache: { dayKey: string; quotes: Map<number, MapleMarketQuote> } = { dayKey: '', quotes: new Map() };
let comparison: Comparison = createEmptyComparison();

function createEmptyComparison(): Comparison {
    return {
        status: 'idle',
        dayKey: '',
        total: 0,
        checked: 0,
        reused: 0,
        queried: 0,
        partial: false,
        updatedAt: 0,
        rows: [],
        error: '',
    };
}

function currentGameDayKey(nowMs: number = getServerTimeSec() * 1000) {
    return formatDateKeyInTimeZone(nowMs, GAME_DAY_TIME_ZONE);
}

function isQuoteComplete(quote: MapleMarketQuote | null | undefined): quote is MapleMarketQuote {
    return !!quote && quote.basePrice > 0 && quote.boost > 0;
}

function syncDayCache(dayKey: string) {
    if (dayCache.dayKey && dayCache.dayKey !== dayKey) {
        dayCache.quotes.clear();
    }
    dayCache.dayKey = dayKey;
}

function resolveFriendName(existingName: string, quote: MapleMarketQuote | null, gid: number) {
    const cleaned = String(existingName || '').trim();
    if (cleaned && !cleaned.startsWith('GID:')) return cleaned;
    return quote?.ownerName || cleaned || `GID:${gid}`;
}

async function queryFriends(current: Comparison, signal: AbortSignal) {
    const scope = createExecutionScope({ signal, rpcBudget: Infinity });
    const queueOptions = { priority: 'scheduled', requestClass: 'background', maxAgedPriority: 'scheduled', source: 'maple-market.compare', signal } as const;
    try {
        return await runWithExecutionScope(scope, async () => {
            const progress = await submitAccountTask('maple-market.compare.phase', getMarketProgress, queueOptions);
            if (progress.phase !== 'active') throw new Error('当前阶段暂无收购报价');
            const dayKey = currentGameDayKey(progress.serverTime);
            syncDayCache(dayKey);
            current.dayKey = dayKey;

            const friends: FriendShop[] = await getFriendsList();
            signal.throwIfAborted();
            const roster = getFriendsListStatus();
            if (roster.state === 'error') throw new Error(roster.error || '读取好友列表失败');
            current.partial = roster.state === 'partial';
            const myGid = getUserState().gid;
            const targets = Array.from(new Map(friends
                .filter(friend => Number.isSafeInteger(friend.gid) && friend.gid > 0 && friend.gid !== myGid)
                .map(friend => [friend.gid, friend])).values());

            current.rows = targets.map((friend) => {
                const cachedQuote = dayCache.quotes.get(friend.gid) || null;
                const complete = isQuoteComplete(cachedQuote);
                return {
                    gid: friend.gid,
                    name: resolveFriendName(friend.name, cachedQuote, friend.gid),
                    quote: cachedQuote ? { ...cachedQuote } : null,
                    failed: false,
                    reused: complete,
                };
            });
            const rowByGid = new Map(current.rows.map(row => [row.gid, row]));
            const pending = current.rows.filter(row => !row.reused);
            current.total = targets.length;
            current.reused = targets.length - pending.length;
            current.queried = pending.length;
            current.checked = current.reused;

            for (let start = 0; start < pending.length; start += BATCH_SIZE) {
                signal.throwIfAborted();
                const batch = pending.slice(start, start + BATCH_SIZE);
                const results = await submitAccountTask('maple-market.compare.batch', () => (
                    Promise.allSettled(batch.map(({ gid }) => getShopQuote(gid, true) as Promise<MapleMarketQuote | null>))
                ), queueOptions);
                signal.throwIfAborted();
                for (const [index, result] of (results as PromiseSettledResult<MapleMarketQuote | null>[]).entries()) {
                    const row = rowByGid.get(batch[index].gid);
                    if (row) {
                        if (result.status === 'fulfilled') {
                            const nextQuote = result.value;
                            row.quote = nextQuote;
                            row.failed = false;
                            row.name = resolveFriendName(row.name, nextQuote, row.gid);
                            if (nextQuote) dayCache.quotes.set(row.gid, { ...nextQuote });
                            else dayCache.quotes.delete(row.gid);
                        } else {
                            row.failed = true;
                        }
                    }
                    current.checked++;
                }
            }
            current.updatedAt = Date.now();
            return current.rows;
        });
    } finally {
        scope.dispose();
    }
}

function getMapleMarketComparison() {
    if (comparison.dayKey && comparison.dayKey !== currentGameDayKey()) clearComparison();
    return comparison;
}

function startMapleMarketComparison() {
    if (job.isRunning()) return comparison;
    const todayKey = currentGameDayKey();
    if (dayCache.dayKey && dayCache.dayKey !== todayKey) {
        dayCache.quotes.clear();
        dayCache.dayKey = '';
    }
    const current: Comparison = { ...createEmptyComparison(), status: 'running', dayKey: dayCache.dayKey };
    comparison = current;
    runWithExecutionScope(null, () => job.start((signal: AbortSignal) => queryFriends(current, signal), {
        onSuccess: (rows: FriendShopResult[]) => {
            current.rows = rows;
            current.status = 'ready';
        },
        onError: (error: any) => {
            current.error = String(error?.message || error);
            current.status = 'failed';
        },
    }));
    return comparison;
}

async function sellToMapleMarketFriend(gid: number, count: number, expectedUnitPrice: number) {
    if (!Number.isSafeInteger(gid) || gid <= 0) {
        throw Object.assign(new Error('无效的好友铺主'), { code: 'INVALID_MAPLE_MARKET_SALE' });
    }
    if (comparison.dayKey && comparison.dayKey !== currentGameDayKey()) {
        clearComparison();
        throw Object.assign(new Error('报价已跨天，请重新查询好友铺子'), { code: 'MAPLE_MARKET_PRICE_CHANGED' });
    }
    const current = comparison;
    const row = current.status === 'ready' ? current.rows.find(entry => entry.gid === gid) : undefined;
    if (!row?.quote?.canSell || row.quote.remainingQuota <= 0) {
        throw Object.assign(new Error('请先查询并选中当前可出售的好友铺子'), { code: 'MAPLE_MARKET_SALE_UNAVAILABLE' });
    }
    const syncQuote = (freshQuote: MapleMarketQuote | null) => {
        row.quote = freshQuote;
        row.failed = false;
        if (freshQuote) {
            row.name = resolveFriendName(row.name, freshQuote, row.gid);
            if (current.dayKey && current.dayKey === dayCache.dayKey) {
                dayCache.quotes.set(row.gid, { ...freshQuote });
            }
        } else if (current.dayKey && current.dayKey === dayCache.dayKey) {
            dayCache.quotes.delete(row.gid);
        }
    };
    const result = await sellMapleMarketCrop(count, expectedUnitPrice, row.gid, { onQuote: syncQuote });
    if (row.quote && typeof result.remainingQuota === 'number') {
        row.quote.remainingQuota = result.remainingQuota;
        if (current.dayKey && current.dayKey === dayCache.dayKey) {
            dayCache.quotes.set(row.gid, { ...row.quote });
        }
    }
    return result;
}

function clearComparison() {
    job.abort();
    dayCache.dayKey = '';
    dayCache.quotes.clear();
    comparison = createEmptyComparison();
}

networkEvents.on('disconnected', clearComparison);
networkEvents.on('sessionClosed', clearComparison);

module.exports = { getMapleMarketComparison, startMapleMarketComparison, sellToMapleMarketFriend };
