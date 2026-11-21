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
const { mountActivityCenterRoutes } = require('./activity-center-routes');
const { mountCommerceRoutes } = require('./commerce-routes');
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

    const webDist = path.join(__dirname, '../../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (_req: any, res: any) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Mount route modules
    mountAuthRoutes(app, ctx);
    mountWxLoginRoutes(app, ctx);
    mountQqLoginRoutes(app, ctx);
    mountCaptureRoutes(app, ctx);
    mountFarmRoutes(app, ctx);
    mountCoinRankRoutes(app, ctx);
    mountFriendRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    mountActivityCenterRoutes(app, ctx);
    mountCommerceRoutes(app, ctx);

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
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
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
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
