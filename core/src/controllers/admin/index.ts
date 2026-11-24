import type { AdminContext } from './context';
export {};

/**
 * Admin panel HTTP server orchestrator.
 * Thin wrapper that wires up Express, routes, Socket.IO, and shared context.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { CONFIG } = require('../../config/config');
const { getResourcePath } = require('../../config/runtime-paths');
const { createModuleLogger } = require('../../services/logger');

const { createAdminContext } = require('./context');
const { mountAuthRoutes } = require('./auth-routes');
const { mountAccountRoutes } = require('./account-routes');
const { mountFarmRoutes } = require('./farm-routes');
const { mountCoinRankRoutes } = require('./coin-rank-routes');
const { mountFriendRoutes } = require('./friend-routes');
const { mountCareerRoutes } = require('./career-routes');
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
const { mountSystemUpdateRoutes } = require('./system-update-routes');
const { readWebBuildInfo } = require('./web-version');
const { mountWxLoginRoutes } = require('./wx-login-routes');
const { mountQqLoginRoutes } = require('./qq-login-routes');
const { mountCaptureRoutes, ensureEmbeddedCaptureService } = require('./capture-routes');
const { mountAdminUserRoutes } = require('./user-routes');
const { mountAdminCardRoutes } = require('./card-routes');
const { mountAdminInviteRoutes } = require('./invite-routes');
const { mountAdminLoginLogRoutes } = require('./login-log-routes');
const { mountAnnouncementRoutes } = require('./announcement-routes');
const { mountAdminMailerRoutes } = require('./mailer-routes');
const {
    setupSocketIO,
    emitRealtimeStatus: _emitStatus,
    emitRealtimeLog: _emitLog,
    emitRealtimeAccountLog: _emitAccountLog,
} = require('./socket');

const adminLogger = createModuleLogger('admin');

let ctx: AdminContext | null = null;

function startAdminServer(dataProvider: any): void {
    if (ctx) return;

    ctx = createAdminContext(dataProvider);

    const app = express();
    // 仅在明确声明部署于可信反代之后时才信任代理跳数；直连公网时关闭，
    // 避免客户端伪造 X-Forwarded-For 绕过 IP 限速（详见 middleware.ts 的 TRUST_PROXY_HEADERS）。
    app.set('trust proxy', process.env.FARM_TRUST_PROXY_HEADERS === 'true' || process.env.FARM_TRUST_PROXY_HEADERS === '1' ? 1 : false);
    app.use(express.json());

    ctx.app = app;

    app.use((req: any, res: any, next: any) => {
        const allowedOrigins: string[] = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = req.headers.origin;

        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }

        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const { getWebRootInfo } = require('../../config/runtime-paths');
    const resolveActiveWebDirs = (): string[] => {
        const { webRoot, fallbackRoots } = getWebRootInfo();
        return [webRoot, ...fallbackRoots];
    };
    const staticMiddlewareCache = new Map<string, any>();
    const setNoStoreHeaders = (res: any) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    };
    const serveDynamicWeb = (req: any, res: any, next: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config') || req.path.startsWith('/socket.io')) return next();
        const dirs = resolveActiveWebDirs();
        for (const cached of staticMiddlewareCache.keys()) {
            if (!dirs.includes(cached)) staticMiddlewareCache.delete(cached);
        }
        let idx = 0;
        const step = (err?: any) => {
            if (err) return next(err);
            if (idx >= dirs.length) return next();
            const dir = dirs[idx++];
            let mw = staticMiddlewareCache.get(dir);
            if (!mw) {
                mw = express.static(dir, {
                    setHeaders: (staticRes: any, filePath: string) => {
                        const base = path.basename(filePath).toLowerCase();
                        if (base === 'index.html' || base === 'version.json') {
                            setNoStoreHeaders(staticRes);
                        }
                    },
                });
                staticMiddlewareCache.set(dir, mw);
            }
            mw(req, res, step);
        };
        step();
    };
    const sendDynamicIndex = (res: any, fallbackStatus: number) => {
        for (const dir of resolveActiveWebDirs()) {
            const indexPath = path.join(dir, 'index.html');
            if (fs.existsSync(indexPath)) {
                setNoStoreHeaders(res);
                return res.sendFile(indexPath);
            }
        }
        if (fallbackStatus !== 200) res.status(fallbackStatus);
        res.send('web build not found. Please build the web project.');
    };
    app.get('/version.json', (_req: any, res: any) => {
        setNoStoreHeaders(res);
        const { webRoot } = getWebRootInfo();
        const info = readWebBuildInfo(webRoot);
        if (info) {
            return res.json(info);
        }
        return res.json({ buildId: '', appVersion: '', builtAt: 0 });
    });
    const [webDist] = resolveActiveWebDirs();
    app.use(serveDynamicWeb);
    if (!fs.existsSync(webDist)) {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => sendDynamicIndex(res, 200));
    }
    // /game-config 同时挂两处静态目录：
    //   1) core/src/gameConfig —— 后端自带的资源（plant_images / seed_images_named / ranch / collections 等）
    //   2) web/dist/game-config —— 前端 public 目录里的资源（career / land_images / scene_images / effect_images / resource-icons 等）
    // 前端的 serveDynamicWeb 显式跳过 /game-config 前缀，所以这些资源只能由这里提供；
    // 之前只挂 core 侧，导致 web/public 里的图片在后端端口下一律 404（生涯图标、土地图、场景图都不显示）。
    // 用两个中间件串联实现「先查后端资源、查不到再落到前端构建产物」，无需复制上万文件。
    app.use('/game-config', express.static(getResourcePath('gameConfig')));
    for (const dir of resolveActiveWebDirs()) {
        const candidate = path.join(dir, 'game-config');
        if (fs.existsSync(candidate)) {
            app.use('/game-config', express.static(candidate));
        }
    }

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountCaptureRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountCoinRankRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountCareerRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);
    mountSystemUpdateRoutes(app, ctx);

    // 多用户体系管理后台（用户/卡密/邀请/登录日志/公告/邮件）
    mountAdminUserRoutes(app, ctx, adminLogger);
    mountAdminCardRoutes(app, ctx, adminLogger);
    mountAdminInviteRoutes(app, ctx);
    mountAdminLoginLogRoutes(app, ctx, adminLogger);
    mountAnnouncementRoutes(app, ctx);
    mountAdminMailerRoutes(app, ctx);

    // SPA fallback
    app.get('*', (req: any, res: any) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        return sendDynamicIndex(res, 404);
    });

    const port: number = CONFIG.adminPort || 3007;
    ctx.server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    // Setup Socket.IO
    setupSocketIO(ctx);

    // 启动进程内抓包服务（若已启用且为嵌入模式；未启用时保存配置后会自动拉起）
    try {
        ensureEmbeddedCaptureService();
    } catch (error: any) {
        adminLogger.warn('capture service bootstrap failed', { error: error?.message || error });
    }

}

async function stopAdminServer(): Promise<void> {
    const server = ctx?.server;
    if (!server) return;
    ctx?.io?.disconnectSockets(true);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closed;
}

function emitRealtimeStatus(accountId: string, status: any): void {
    if (!ctx) return;
    _emitStatus(ctx, accountId, status);
}

function emitRealtimeLog(entry: any): void {
    if (!ctx) return;
    _emitLog(ctx, entry);
}

function emitRealtimeAccountLog(entry: any): void {
    if (!ctx) return;
    _emitAccountLog(ctx, entry);
}

module.exports = {
    startAdminServer, stopAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
