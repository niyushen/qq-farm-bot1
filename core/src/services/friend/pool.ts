export {};
/**
 * 好友号池（移植自 BUGDey v2.18.12）：分享卡片全账号共享，申请状态按账号隔离。
 *
 * data/friend-pool.json:
 *   items:   { [uid]: {uid, openid, shareKey, shareSource, docId, name, level, ...} }
 *   applies: { [accountId]: { [uid]: {status, lastApplyAt, applyCount, deadReason} } }
 *   limits:  { [accountId]: {dateKey, at, error} }  当日撞过申请上限的账号直接跳过后续批次
 *
 * 状态是惰性的：读取时按 lastApplyAt 推导 pending 是否超过 24h（expired）。
 */

const fs = require('node:fs');
const { getDataFile } = require('../../config/runtime-paths');
const { readTextFile, writeTextFileAtomic } = require('../json-db');
const { log } = require('../../utils/utils');

const POOL_VERSION = 2;
const APPLY_PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

interface PoolItem {
    uid: string; openid: string; shareKey: string; shareSource: string; docId: string;
    cardTime: string; name: string; level: number; dogBreed?: string; identifiedAt?: number;
    visitClosed?: boolean;
    firstSeenAt: number; updatedAt: number;
}
interface ApplyState {
    status: string; lastApplyAt: number | null; applyCount: number;
    deadAt: number | null; deadReason: string; updatedAt: number;
    /** 最后一次成功的动作是申请还是强制直加 */
    mode?: 'apply' | 'force';
    /** 强制直加时服务端回包 relation.is_friend（true = 真的绑上了） */
    arkBound?: boolean;
}
interface PoolData {
    version: number;
    items: Record<string, PoolItem>;
    applies: Record<string, Record<string, ApplyState>>;
    limits: Record<string, { dateKey: string; at: number; error: string }>;
}

let cache: PoolData | null = null;
let cacheMtime = -1;
let cacheSize = -1;

function poolFile(): string {
    const override = String(process.env.FARM_FRIEND_POOL_FILE || '').trim();
    return override || getDataFile('friend-pool.json');
}

function fileStat(): { mtime: number; size: number } {
    try {
        const stat = fs.statSync(poolFile());
        return { mtime: stat.mtimeMs, size: stat.size };
    } catch {
        return { mtime: -1, size: -1 };
    }
}

function emptyPool(): PoolData {
    return { version: POOL_VERSION, items: {}, applies: {}, limits: {} };
}

function load(): PoolData {
    const stat = fileStat();
    if (cache && stat.mtime === cacheMtime && stat.size === cacheSize) return cache;
    try {
        const parsed = JSON.parse(readTextFile(poolFile(), ''));
        cache = (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object')
            ? {
                version: POOL_VERSION,
                items: parsed.items,
                applies: parsed.applies && typeof parsed.applies === 'object' ? parsed.applies : {},
                limits: parsed.limits && typeof parsed.limits === 'object' ? parsed.limits : {},
            }
            : emptyPool();
    } catch {
        cache = emptyPool();
    }
    cacheMtime = stat.mtime;
    cacheSize = stat.size;
    return cache!;
}

function save(): void {
    if (!cache) return;
    try {
        writeTextFileAtomic(poolFile(), JSON.stringify(cache, null, 2));
        const stat = fileStat();
        cacheMtime = stat.mtime;
        cacheSize = stat.size;
    } catch (error: any) {
        log('号池', `号池写入失败: ${error?.message || error}`, { module: 'friend-pool', result: 'error' });
    }
}

function identity(item: any): string {
    const openid = String(item?.openid || '').trim();
    if (openid) return `openid:${openid}`;
    const key = String(item?.shareKey || '').trim();
    if (key) return `key:${key}`;
    return `uid:${String(item?.uid || '').trim()}`;
}

/** 导入分享卡片（全账号共享）；同一人按 openid/shareKey 去重，卡片时间新的覆盖旧的。 */
function upsertItems(items: any[]): { added: number; updated: number } {
    const pool = load();
    const owners = new Map<string, string>();
    for (const [uid, item] of Object.entries(pool.items)) owners.set(identity({ ...item, uid }), uid);
    let added = 0;
    let updated = 0;
    for (const raw of Array.isArray(items) ? items : []) {
        const uid = String(raw?.uid || '').trim();
        if (!uid) continue;
        const incoming = {
            openid: String(raw?.openid || raw?.openId || '').trim(),
            shareKey: String(raw?.shareKey || raw?.share_key || '').trim(),
            shareSource: String(raw?.shareSource ?? ''),
            docId: String(raw?.docId ?? ''),
            cardTime: String(raw?.cardTime ?? ''),
        };
        const id = identity({ uid, ...incoming });
        const target = pool.items[uid] ? uid : (owners.get(id) || '');
        if (!target) {
            pool.items[uid] = {
                uid, ...incoming, name: String(raw?.name || ''), level: Number(raw?.level) || 0,
                ...(raw?.dogBreed ? { dogBreed: String(raw.dogBreed) } : {}),
                firstSeenAt: Date.now(), updatedAt: Date.now(),
            };
            owners.set(id, uid);
            added += 1;
            continue;
        }
        updated += 1;
        const existing = pool.items[target];
        if (incoming.cardTime && existing.cardTime && incoming.cardTime < existing.cardTime) continue;
        if (incoming.shareKey) existing.shareKey = incoming.shareKey;
        if (incoming.openid) existing.openid = incoming.openid;
        if (incoming.shareSource) existing.shareSource = incoming.shareSource;
        if (incoming.docId) existing.docId = incoming.docId;
        if (incoming.cardTime) existing.cardTime = incoming.cardTime;
        if (raw?.name) existing.name = String(raw.name);
        if (Number(raw?.level) > 0) existing.level = Number(raw.level);
        existing.updatedAt = Date.now();
    }
    save();
    return { added, updated };
}

function appliesFor(accountId: string): Record<string, ApplyState> {
    const pool = load();
    const key = String(accountId || 'default');
    if (!pool.applies[key] || typeof pool.applies[key] !== 'object') pool.applies[key] = {};
    return pool.applies[key];
}

function statusOf(state: ApplyState | undefined, now = Date.now()): string {
    if (!state) return 'new';
    if (state.status === 'friend') return 'friend';
    if (state.lastApplyAt && now - state.lastApplyAt >= APPLY_PENDING_WINDOW_MS) return 'expired';
    if (state.lastApplyAt) return 'pending';
    return 'new';
}

/** 账号视角的号池快照：只带状态摘要，不把全量申请记录塞给前端。 */
function snapshot(accountId: string): any {
    const pool = load();
    const applies = appliesFor(accountId);
    const items = Object.values(pool.items).map(item => ({
        ...item,
        status: statusOf(applies[item.uid]),
        applyCount: Number(applies[item.uid]?.applyCount) || 0,
        lastApplyAt: applies[item.uid]?.lastApplyAt || null,
        mode: applies[item.uid]?.mode || '',
        arkBound: applies[item.uid]?.arkBound === true,
    }));
    items.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const limit = pool.limits[String(accountId || 'default')];
    const today = new Date().toLocaleDateString('sv-SE');
    return {
        items,
        total: items.length,
        counts: items.reduce((acc: Record<string, number>, item: any) => {
            acc[item.status] = (acc[item.status] || 0) + 1;
            return acc;
        }, {}),
        dailyLimit: limit && limit.dateKey === today ? limit : null,
    };
}

function getStatusMap(accountId: string): Record<string, string> {
    const pool = load();
    const applies = appliesFor(accountId);
    const map: Record<string, string> = {};
    for (const uid of Object.keys(pool.items)) map[uid] = statusOf(applies[uid]);
    return map;
}

function markApplied(accountId: string, uid: string): void {
    const pool = load();
    const key = String(uid);
    const applies = appliesFor(accountId);
    const state = applies[key] || { status: 'new', applyCount: 0, lastApplyAt: null, deadAt: null, deadReason: '', updatedAt: 0 };
    state.lastApplyAt = Date.now();
    state.applyCount = (state.applyCount || 0) + 1;
    state.status = 'pending';
    state.deadAt = null;
    state.deadReason = '';
    state.updatedAt = Date.now();
    applies[key] = state;
    if (pool.items[key]?.visitClosed) {
        delete pool.items[key].visitClosed;
        delete (pool.items[key] as any).visitClosedAt;
    }
    save();
}

function markFriend(accountId: string, uid: string): void {
    const applies = appliesFor(accountId);
    const state = applies[String(uid)] || { status: 'new', applyCount: 0, lastApplyAt: null, deadAt: null, deadReason: '', updatedAt: 0 };
    state.status = 'friend';
    state.updatedAt = Date.now();
    applies[String(uid)] = state;
    save();
}

function markDead(accountId: string, uid: string, reason: string): void {
    const applies = appliesFor(accountId);
    const state = applies[String(uid)] || { status: 'new', applyCount: 0, lastApplyAt: null, deadAt: null, deadReason: '', updatedAt: 0 };
    state.status = 'dead';
    state.deadAt = Date.now();
    state.deadReason = String(reason || '');
    state.updatedAt = Date.now();
    applies[String(uid)] = state;
    save();
}

function updateProfile(uid: string, extra: { name?: string; level?: number; dogBreed?: string }): void {
    const pool = load();
    const item = pool.items[String(uid)];
    if (!item) return;
    if (extra.name) item.name = String(extra.name);
    if (Number(extra.level) > 0) item.level = Number(extra.level);
    if (extra.dogBreed) item.dogBreed = String(extra.dogBreed);
    if (extra.name || Number(extra.level) > 0 || extra.dogBreed) item.identifiedAt = Date.now();
    item.updatedAt = Date.now();
    save();
}

/**
 * 强制添加（ReportArkClick）后的记账：服务端回包 relation.is_friend 才是硬判定。
 * bound=false 表示请求发出去了但服务端没绑定（openid 与 share_key 不匹配 / 对方好友位满）。
 */
function markArkApplied(accountId: string, uid: string, bound: boolean): void {
    const pool = load();
    const key = String(uid);
    const applies = appliesFor(accountId);
    const state = applies[key] || { status: 'new', applyCount: 0, lastApplyAt: null, deadAt: null, deadReason: '', updatedAt: 0 };
    state.lastApplyAt = Date.now();
    state.applyCount = (state.applyCount || 0) + 1;
    state.mode = 'force';
    state.arkBound = !!bound;
    state.updatedAt = Date.now();
    if (bound) {
        state.status = 'friend';
    } else {
        // 没绑上：标成 pending 让下一轮还能再试（不写成 dead，避免误杀有效卡片）。
        state.status = 'pending';
        state.deadReason = '强制添加未绑定（openid 与 share_key 可能不匹配）';
    }
    applies[key] = state;
    save();
}

function removeItem(uid: string): boolean {
    const pool = load();
    const key = String(uid);
    if (!pool.items[key]) return false;
    delete pool.items[key];
    for (const accountId of Object.keys(pool.applies)) delete pool.applies[accountId]?.[key];
    save();
    return true;
}

function dailyLimitBlocked(accountId: string): boolean {
    const limit = load().limits[String(accountId || 'default')];
    return !!limit && limit.dateKey === new Date().toLocaleDateString('sv-SE');
}

function markDailyLimit(accountId: string, error: string): void {
    const pool = load();
    pool.limits[String(accountId || 'default')] = {
        dateKey: new Date().toLocaleDateString('sv-SE'), at: Date.now(), error: String(error || ''),
    };
    save();
}

function clearDailyLimit(accountId: string): void {
    const pool = load();
    delete pool.limits[String(accountId || 'default')];
    save();
}

/** 已在好友列表里的 GID：申请前先跳过，重复申请既费额度又招人烦。 */
function loadFriendGidSet(): Set<string> {
    const gids = new Set<string>();
    try {
        const { getFriendsListCacheOnly } = require('../friend');
        const friends = getFriendsListCacheOnly?.() || [];
        for (const friend of friends) {
            const gid = Number(friend?.gid ?? friend?.friendGid ?? friend?.uin);
            if (Number.isFinite(gid) && gid > 0) gids.add(String(gid));
        }
    } catch {}
    return gids;
}

module.exports = {
    upsertItems, snapshot, getStatusMap, markApplied, markFriend, markDead,
    updateProfile, removeItem, dailyLimitBlocked, markDailyLimit, clearDailyLimit,
    loadFriendGidSet, markArkApplied,
};
