/**
 * Socket.IO setup and realtime emit functions.
 */
import type { AdminContext } from './context';
export {};

const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const SocketIOServer = Server;
const { getRuntimePaths } = require('../../config/runtime-paths');
const { getActiveWebBuildId } = require('./web-version');

const {
    resolveAccId,
    getAccountList,
} = require('./middleware');

function applySocketSubscription(ctx: AdminContext, socket: any, accountRef: string = ''): void {
    const incoming = String(accountRef || '').trim();
    const user = socket.data.user || null;
    // 用户隔离：resolveAccId 传入当前用户，普通用户解析他人账号会得到空
    const resolved = incoming && incoming !== 'all' ? resolveAccId(ctx, incoming, user) : '';

    for (const room of socket.rooms) {
        if (room.startsWith('account:')) socket.leave(room);
    }
    if (resolved) {
        socket.join(`account:${resolved}`);
        socket.data.accountId = resolved;
    } else if (!user) {
        socket.join('account:all');
        socket.data.accountId = '';
    } else {
        // 登录用户未指定（或无权访问）账号：加入个人聚合房间，推送按归属过滤
        socket.join('account:all');
        socket.data.accountId = '';
    }
    socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

    try {
        const targetId = socket.data.accountId || '';
        if (targetId && ctx.provider && typeof ctx.provider.getStatus === 'function') {
            const currentStatus = ctx.provider.getStatus(targetId);
            socket.emit('status:update', { accountId: targetId, status: currentStatus });
        }
        if (ctx.provider && typeof ctx.provider.getLogs === 'function') {
            // 快照按空间分推：前端按 space 分别替换对应缓冲，
            // 合并推一份的话总量只有 100 条，「每空间 100 条」无法成立
            for (const space of ['ranch', 'farm']) {
                let currentLogs: any[] = ctx.provider.getLogs(targetId, { limit: 100, space });
                if (!Array.isArray(currentLogs)) currentLogs = [];
                // 用户隔离：聚合视图（account:all）按归属过滤日志
                if (!targetId && user) {
                    const ownedIds = new Set(getAccountList(ctx, user).map((a: any) => String(a.id || '')).filter(Boolean));
                    currentLogs = currentLogs.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));
                }

                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    space,
                    logs: currentLogs,
                });
            }
        }
        if (ctx.provider && typeof ctx.provider.getAccountLogs === 'function') {
            let currentAccountLogs: any[] = ctx.provider.getAccountLogs(100);
            if (!Array.isArray(currentAccountLogs)) currentAccountLogs = [];
            // 用户隔离：账号操作日志只推自己账号的
            if (user) {
                const ownedIds = new Set(getAccountList(ctx, user).map((a: any) => String(a.id || '')).filter(Boolean));
                currentAccountLogs = currentAccountLogs.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));
            }

            socket.emit('account-logs:snapshot', {
                logs: currentAccountLogs,
            });
        }
    } catch {
        // ignore snapshot push errors
    }
}

function setupSocketIO(ctx: AdminContext): void {
    ctx.io = new SocketIOServer(ctx.server as any, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    ctx.io.use((socket: any, next: (err?: Error) => void) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !ctx.tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        // 用户隔离：识别连接者身份（多用户会话），普通用户只能订阅/接收自己账号的推送
        const session = ctx.sessions.get(token) || null;
        if (!session) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        socket.data.user = session;
        return next();
    });

    let lastNotifiedBuildId = getActiveWebBuildId();
    let webWatchTimer: ReturnType<typeof setTimeout> | null = null;
    let webWatcher: any = null;

    const notifyIfWebChanged = () => {
        const nextBuildId = getActiveWebBuildId();
        if (nextBuildId && nextBuildId !== lastNotifiedBuildId) {
            lastNotifiedBuildId = nextBuildId;
            ctx.io?.emit('panel:version', { webBuildId: nextBuildId, ts: Date.now() });
        }
    };

    try {
        const pointerFile = getRuntimePaths().webRootPointerFile;
        const pointerDir = path.dirname(pointerFile);
        const pointerName = path.basename(pointerFile);
        if (fs.existsSync(pointerDir)) {
            webWatcher = fs.watch(pointerDir, (_eventType: string, filename: string | Buffer | null) => {
                if (filename && String(filename) !== pointerName) return;
                if (webWatchTimer) clearTimeout(webWatchTimer);
                webWatchTimer = setTimeout(notifyIfWebChanged, 150);
                webWatchTimer.unref?.();
            });
            webWatcher.unref?.();
            webWatcher.on?.('error', () => {
                // ignore watcher errors on ephemeral filesystems
            });
        }
    } catch {
        // ignore fs.watch unsupported environments
    }

    ctx.server?.once('close', () => {
        if (webWatchTimer) {
            clearTimeout(webWatchTimer);
            webWatchTimer = null;
        }
        try {
            webWatcher?.close?.();
        } catch {
            // ignore close error
        }
        webWatcher = null;
    });

    ctx.io.on('connection', (socket: any) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(ctx, socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now(), webBuildId: getActiveWebBuildId() });

        socket.on('subscribe', (payload: any) => {
            if (!ctx.tokens.has(socket.data.adminToken)) return socket.disconnect(true);
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(ctx, socket, body.accountId || '');
        });
    });
}

function emitRealtimeStatus(ctx: AdminContext, accountId: string, status: any): void {
    if (!ctx.io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('account-log:new', payload);
}

module.exports = {
    setupSocketIO,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
