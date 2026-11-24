import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Friend-related routes: friends list, friend lands, friend ops,
 * friend-blacklist, friend-known-gids, interact-records.
 */

const store = require('../../models/store');

const {
    getAccId,
    handleApiError,
    isGatewayProtocolError,
    isSoftRuntimeError,
    buildKnownFriendGidSettings,
    canAccessAccount,
} = require('./middleware');

/**
 * 把各种来源的一条记录归一成号池条目（采集器 {gid,shareKey,openid} 与手工 {uid,...} 都收）。
 */
function normalizePoolItem(item: any): any {
    if (!item || typeof item !== 'object') return null;
    const uid = String(item.uid ?? item.gid ?? item.sharer_id ?? '').trim();
    if (!/^\d+$/.test(uid) || Number(uid) <= 0) return null;
    const openid = String(item.openid ?? item.openId ?? item.sharer_open_id ?? '').trim();
    const shareKey = String(item.shareKey ?? item.share_key ?? '').trim();
    if (!openid && !shareKey) return null;
    const shareSource = item.shareSource ?? item.share_source ?? item.shareCfgId ?? item.share_cfg_id ?? '';
    const docId = item.docId ?? item.doc_id ?? '';
    return {
        uid, openid, shareKey,
        shareSource: String(shareSource ?? ''),
        docId: String(docId ?? ''),
        cardTime: String(item.cardTime ?? item.card_time ?? item.at ?? ''),
        name: String(item.name || ''),
        level: Number(item.level) || 0,
        ...(item.dogBreed ? { dogBreed: String(item.dogBreed) } : {}),
    };
}

/** 解析一行 `?uid=..&openid=..&share_key=..` 或带时间前缀的采集日志行。 */
function parsePoolLine(line: string): any {
    const text = String(line || '').trim();
    if (!text) return null;
    const paramRe = /(?:^|[?&\s"'<|])(uid|openid|share_source|doc_id|share_key)=([^&\s"'<|]+)/g;
    const params: Record<string, string> = {};
    let firstIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = paramRe.exec(text)) !== null) {
        if (!(match[1] in params)) params[match[1]] = match[2];
        if (firstIndex < 0) firstIndex = match.index;
    }
    if (firstIndex < 0) return null;
    const cardTime = firstIndex > 0 ? text.slice(0, firstIndex).replace(/[|?&\s]+$/, '').trim() : '';
    return normalizePoolItem({
        uid: params.uid, openid: params.openid,
        shareSource: params.share_source, docId: params.doc_id,
        shareKey: params.share_key, cardTime,
    });
}

function mountFriendRoutes(app: Application, ctx: AdminContext): void {

    // API: 好友列表
    app.get('/api/friends', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const forceSync = req.query.forceSync === 'true';

        try {
            const data = await ctx.provider.getFriends(id, forceSync);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 仅读取 Worker 内存中的好友列表缓存，不触发任何游戏协议请求。
    app.get('/api/friends/cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });
        try {
            const data = await ctx.provider.getFriendsCache(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 清除好友列表缓存
    app.post('/api/friends/clear-cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            await ctx.provider.clearFriendsCache(id);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });
        try {
            const data = await ctx.provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const data = await ctx.provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包中当前可用于好友土地的特殊互动道具。
    app.get('/api/friend-interaction-items', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const data = await ctx.provider.getFriendInteractionItems(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 在同一次好友访问会话内，按地块编号顺序使用特殊互动道具。
    app.post('/api/friend/:gid/interaction-items/use-batch', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const data = await ctx.provider.useFriendInteractionItemBatch(
                id,
                req.params.gid,
                req.body?.itemId,
                req.body?.landIds,
            );
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友农场使用不需要地块目标的特殊互动道具（例如青蛙使坏瓶）。
    app.post('/api/friend/:gid/interaction-items/use-farm', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const data = await ctx.provider.useFriendFarmInteractionItem(id, req.params.gid, req.body?.itemId);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await ctx.provider.doFriendOp(id, req.params.gid, opType);
            if (data && data.ok === false) {
                return res.json({
                    ok: false,
                    error: data.errorMessage || data.message || data.error || '好友操作失败',
                    ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
                    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
                });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 游戏内删除好友
    app.post('/api/friend/:gid/delete', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const gid = Number(req.params.gid);
            if (!Number.isFinite(gid) || gid <= 0) {
                return res.status(400).json({ ok: false, error: '无效的好友 GID' });
            }
            const data = await ctx.provider.delFriend(id, gid);
            if (store.addFriendToBlacklist) {
                store.addFriendToBlacklist(id, gid);
            }
            if (store.getKnownFriendGids && store.setKnownFriendGids) {
                const current = store.getKnownFriendGids(id) || [];
                const next = current.filter((item: any) => Number(item) !== gid);
                if (next.length !== current.length) {
                    store.setKnownFriendGids(id, next);
                }
            }
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            res.json({ ok: true, message: '删除好友成功', data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const gids = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];

        // 尝试获取好友列表以附加昵称和头像
        let friendsList: any[] = [];
        try {
            if (ctx.provider && typeof ctx.provider.getFriends === 'function') {
                friendsList = await ctx.provider.getFriends(id) || [];
            }
        } catch (error: any) {
            if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) return handleApiError(res, error);
            // 非协议错误不影响黑名单本地数据展示
        }

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0) {
                friendMap.set(gid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const list = gids.map((gid: any) => {
            const info = friendMap.get(Number(gid)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(gid),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next: number[];
        if (current.includes(gid)) {
            next = current.filter((g: number) => g !== gid);
        } else {
            next = [...current, gid];
        }
        const savedGids = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;

        // 同步配置到 worker 进程
        if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
            ctx.provider.broadcastConfig(id);
        }

        // 尝试获取好友列表以附加昵称和头像
        let friendsList: any[] = [];
        try {
            if (ctx.provider && typeof ctx.provider.getFriends === 'function') {
                friendsList = await ctx.provider.getFriends(id) || [];
            }
        } catch (error: any) {
            if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) return handleApiError(res, error);
            // 非协议错误不影响黑名单本地数据展示
        }

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const fGid = Number(f && f.gid);
            if (fGid > 0) {
                friendMap.set(fGid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const saved = savedGids.map((g: any) => {
            const info = friendMap.get(Number(g)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(g),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: saved });
    });

    /**
     * 外挂检测：基于访客互动样本（72 小时窗口）的行为分析。
     * 纯本地数据，不触发游戏请求；好友昵称/头像从缓存名单里补。
     */
    app.get('/api/friend-cheat-analysis', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        let analysis: any;
        try {
            analysis = require('../../services/friend/cheat-detect').analyzeFriendCheat(String(id));
        } catch (e: any) {
            return handleApiError(res, e);
        }

        // 好友昵称/头像只是锦上添花：账号离线或 provider 报错时直接跳过，
        // 不能让「本地样本分析」被一次网络请求拖成失败。
        let friendsList: any[] = [];
        try {
            const raw = typeof ctx.provider?.getFriends === 'function' ? await ctx.provider.getFriends(id) : [];
            friendsList = Array.isArray(raw) ? raw : [];
        }
        catch {
            friendsList = [];
        }
        const friendMap = new Map<number, { name: string, avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0)
                friendMap.set(gid, { name: f.name || f.remark || '', avatarUrl: f.avatarUrl || f.avatar_url || '' });
        }
        const visitors = (analysis.visitors || []).map((visitor: any) => {
            const info = friendMap.get(Number(visitor.gid));
            return {
                ...visitor,
                name: info?.name || visitor.nick || `GID:${visitor.gid}`,
                avatarUrl: info?.avatarUrl || '',
            };
        });

        return res.json({ ok: true, data: { ...analysis, visitors } });
    });

    // ============ 好友GID管理 API ============

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            if (body.friendsListCacheTtlSec !== undefined && store.setFriendsListCacheTtlSec) {
                store.setFriendsListCacheTtlSec(id, body.friendsListCacheTtlSec);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter((item: any) => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0));
            const next = current.filter((gid: any) => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // ==================== 好友号池 / 主动加好友 ====================
    // 号池文件全账号共享，状态按账号隔离；导入/删除在主进程直接落盘，
    // 真正发申请必须通过 worker（游戏连接在那里，且要独占自动化）。
    app.get('/api/friends/pool', (req: Request, res: Response) => {
        const id = getAccId(ctx, req) || 'default';
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });
        try {
            res.json({ ok: true, data: require('../../services/friend/pool').snapshot(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/friends/pool/import', (req: Request, res: Response) => {
        const raw = String((req.body || {}).text || '').trim();
        const items: any[] = [];
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
                const parsed = JSON.parse(raw);
                const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
                for (const entry of entries) {
                    const item = normalizePoolItem(entry);
                    if (item) items.push(item);
                }
            } catch {
                return res.status(400).json({ ok: false, error: 'JSON 解析失败，请检查粘贴内容' });
            }
        } else {
            for (const line of raw.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)) {
                const item = parsePoolLine(line);
                if (item) items.push(item);
            }
        }
        try {
            const result = items.length
                ? require('../../services/friend/pool').upsertItems(items)
                : { added: 0, updated: 0 };
            res.json({ ok: true, data: { ...result, parsed: items.length } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 采集器兼容层（card-collector）：body {users:[{gid,shareKey,openid,shareCfgId}]}
    app.post('/api/auto-friend/pool/import', (req: Request, res: Response) => {
        const body = req.body || {};
        const entries: any[] = Array.isArray(body.users) ? body.users : (Array.isArray(body.items) ? body.items : []);
        const items: any[] = [];
        let skipped = 0;
        for (const entry of entries) {
            const item = normalizePoolItem(entry);
            if (item) items.push(item);
            else skipped += 1;
        }
        if (!entries.length && typeof body.text === 'string') {
            for (const line of String(body.text).split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)) {
                const item = parsePoolLine(line);
                if (item) items.push(item);
                else skipped += 1;
            }
        }
        try {
            const result = items.length
                ? require('../../services/friend/pool').upsertItems(items)
                : { added: 0, updated: 0 };
            res.json({ ok: true, data: { ...result, skipped, parsed: items.length } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/auto-friend/pool', (req: Request, res: Response) => {
        const id = getAccId(ctx, req) || 'default';
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });
        try {
            res.json({ ok: true, data: require('../../services/friend/pool').snapshot(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/friends/pool/:uid', (req: Request, res: Response) => {
        try {
            const removed = require('../../services/friend/pool').removeItem(req.params.uid);
            res.json({ ok: true, data: { removed } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/friends/apply-invites', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        if (!canAccessAccount(ctx, req, id)) return res.status(403).json({ ok: false, error: '无权操作该账号' });
        const body = req.body || {};
        try {
            const data = await ctx.provider.applyFriendInvites(id, Array.isArray(body.items) ? body.items : [], body.options || {});
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountFriendRoutes, normalizePoolItem, parsePoolLine };
