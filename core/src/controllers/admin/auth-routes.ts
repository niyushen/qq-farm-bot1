import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const userStore = require('../../models/user-store');
const store = require('../../models/store');
const { USER_SYSTEM_CONFIG, USER_ROLES, isElevatedRole } = require('../../config/user-system');
const inviteService = require('../../services/invite-rewards');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccId,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function statusForError(errorType: string): number {
    if (errorType === 'rate_limit') return 429;
    if (errorType === 'locked') return 423;
    if (errorType === 'disabled') return 403;
    if (errorType === 'expired') return 403;
    return 401;
}

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    /** 登录：用户名 + 密码，校验有效期与封禁状态 */
    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        const ip = getClientIp(req);
        const userAgent = String(req.headers['user-agent'] || '');

        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const result = userStore.validateUser(String(username), String(password), ip);
        if (!result || result.error) {
            const errorType = result ? result.error : 'invalid_credentials';
            const message = result ? result.message : '用户名或密码错误';
            adminLogger.warn('登录失败', { username, error: errorType, ip, message });
            userStore.addLoginLog('login_failed', String(username), errorType, ip, userAgent);
            return res.status(statusForError(errorType)).json({
                ok: false,
                error: message,
                errorType,
                remainingMs: result ? result.remainingMs : undefined,
            });
        }

        // 有效期与封禁检查（超级管理员豁免）
        const subscription = result.subscription || result.card || null;
        if (result.role === USER_ROLES.USER && subscription) {
            if (subscription.enabled === false) {
                userStore.addLoginLog('login_rejected', result.username, 'disabled', ip, userAgent);
                return res.status(403).json({ ok: false, error: '账号已被禁用，请联系管理员', errorType: 'disabled' });
            }
            if (userStore.isSubscriptionExpired(subscription)) {
                userStore.addLoginLog('login_rejected', result.username, 'expired', ip, userAgent);
                return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录', errorType: 'expired' });
            }
        }

        userStore.addLoginLog('login_success', result.username, null, ip, userAgent);

        const token = issueToken();
        ctx.tokens.add(token);
        ctx.sessions.set(token, {
            id: result.id,
            username: result.username,
            role: result.role,
            accountLimit: result.accountLimit,
            subscription: result.subscription || null,
            card: result.subscription || null,
            mustChangePassword: result.mustChangePassword === true,
            createdAt: Date.now(),
        });
        adminLogger.info('登录成功', { username: result.username, role: result.role, ip });

        return res.json({
            ok: true,
            data: {
                token,
                role: result.role,
                card: subscription,
                subscription,
                accountLimit: result.accountLimit,
                expiresAt: subscription ? subscription.expiresAt : null,
                isPermanent: subscription ? subscription.isPermanent === true : true,
                isExpired: subscription ? userStore.isSubscriptionExpired(subscription) : false,
                user: { username: result.username },
                mustChangePassword: result.mustChangePassword === true,
            },
        });
    });

    /** 注册：必须绑定一张加时卡，卡密面值决定初始有效期；邀请码可选 */
    app.post('/api/register', (req: Request, res: Response) => {
        const { username, password, cardCode, inviteCode } = req.body || {};
        const ip = getClientIp(req);
        if (!username || !password || !cardCode) {
            return res.status(400).json({ ok: false, error: '请填写用户名、密码和卡密' });
        }
        const rate = userStore.checkRateLimit(ip);
        if (!rate.allowed) {
            return res.status(429).json({ ok: false, error: rate.message, errorType: 'rate_limit' });
        }

        const result = userStore.registerUser(username, password, cardCode, { ip });
        if (!result.ok) {
            userStore.addLoginLog('register_failed', String(username), 'invalid_card', ip, String(req.headers['user-agent'] || ''));
            return res.status(400).json(result);
        }
        userStore.addLoginLog('register_success', result.user.username, null, ip, String(req.headers['user-agent'] || ''));

        // 邀请奖励：任何异常都不能影响注册结果
        let invite: any = null;
        if (inviteCode) {
            try {
                invite = inviteService.handleRegistration({
                    inviteCode,
                    invitee: result.user.username,
                    ip,
                    userStore,
                });
                if (invite.ok) {
                    adminLogger.info('邀请奖励已处理', {
                        inviter: invite.inviter,
                        invitee: result.user.username,
                        pending: invite.pending,
                        inviteeDays: invite.inviteeDays,
                        ip,
                    });
                } else {
                    adminLogger.warn('邀请码未生效', { invitee: result.user.username, reason: invite.reason, ip });
                }
            } catch (error: any) {
                adminLogger.warn('邀请奖励处理失败', { invitee: result.user.username, error: error.message });
                invite = null;
            }
        }

        return res.json({ ok: true, data: result.user, invite });
    });

    /** 卡密预览：注册页输入卡密后回显面值（不消耗卡密） */
    app.get('/api/card/info/:code', (req: Request, res: Response) => {
        try {
            const peek = userStore.peekCard(String(req.params.code || ''));
            if (!peek.ok) return res.status(400).json({ ok: false, error: peek.error });
            return res.json({ ok: true, data: peek.card });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 当前用户配置概览（含额度使用情况） */
    app.get('/api/user/quota', authRequired, (req: any, res: Response) => {
        const currentUser = req.currentUser;
        if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });
        const accounts = ctx.provider && typeof ctx.provider.getAccounts === 'function'
            ? ctx.provider.getAccounts().accounts || []
            : [];
        const accountCount = isElevatedRole(currentUser.role)
            ? accounts.length
            : accounts.filter((account: any) =>
                String(account.owner || account.username || '') === String(currentUser.username)).length;
        return res.json({
            ok: true,
            data: {
                username: currentUser.username,
                role: currentUser.role,
                accountLimit: currentUser.accountLimit,
                accountCount,
                subscription: currentUser.subscription || currentUser.card || null,
                card: currentUser.subscription || currentUser.card || null,
            },
        });
    });

    /** 自助续费：加时卡延长有效期，额度卡提升账号配额 */
    app.post('/api/user/renew', authRequired, (req: Request, res: Response) => {
        const { cardCode } = req.body || {};
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

        const result = userStore.renewUser(username, String(cardCode));
        if (!result.ok) return res.status(400).json(result);

        for (const [token, session] of ctx.sessions.entries()) {
            if (session.username === username) {
                session.subscription = result.subscription;
                session.card = result.subscription;
                session.accountLimit = result.accountLimit;
                ctx.sessions.set(token, session);
            }
        }
        return res.json({
            ok: true,
            data: {
                card: result.subscription,
                subscription: result.subscription,
                accountLimit: result.accountLimit,
                cardType: result.cardType,
                summary: result.summary,
            },
        });
    });

    /** 修改密码（只改当前登录账号自己的密码；成功后吊销该用户全部会话） */
    app.post('/api/user/change-password', authRequired, (req: Request, res: Response) => {
        const { oldPassword, newPassword } = req.body || {};
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const result = userStore.changePassword(username, String(oldPassword), String(newPassword));
        if (result?.ok) {
            // 用户隔离/安全：密码修改成功后吊销该用户的所有会话（旧 token 全部失效，需重新登录）
            for (const [token, session] of ctx.sessions.entries()) {
                if (String(session?.username || '') === String(username)) {
                    ctx.sessions.delete(token);
                    ctx.tokens.delete(token);
                }
            }
        }
        return res.json(result);
    });

    /** 公开账号状态查询（免登录续费弹窗显示账号现状，只回传续费需要的字段） */
    app.get('/api/public/account-status', (req: Request, res: Response) => {
        try {
            const username = String((req.query as any)?.username || '').trim();
            if (!username) return res.status(400).json({ ok: false, error: '请输入账号' });

            const rate = userStore.checkRateLimit(getClientIp(req));
            if (!rate.allowed) {
                return res.status(429).json({ ok: false, error: rate.message, errorType: 'rate_limit' });
            }

            const user = userStore.getUserByName(username);
            if (!user) return res.json({ ok: true, data: { exists: false, username } });
            const subscription = user.subscription || user.card || null;
            const expiresAt = Number(subscription?.expiresAt) || null;
            return res.json({
                ok: true,
                data: {
                    exists: true,
                    username: user.username,
                    isExpired: userStore.isSubscriptionExpired(subscription) === true,
                    isPermanent: subscription?.isPermanent === true,
                    expiresAt,
                    expiresAtText: expiresAt
                        ? new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })
                        : (subscription?.isPermanent ? '永久有效' : ''),
                    accountLimit: Number(user.accountLimit),
                },
            });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 免登录续费（凭用户名 + 卡密） */
    app.post('/api/public/renew', (req: Request, res: Response) => {
        try {
            if (!USER_SYSTEM_CONFIG.allowPublicRenew) {
                return res.status(403).json({ ok: false, error: '未开放公开续费' });
            }
            const ip = getClientIp(req);
            const rate = userStore.checkRateLimit(ip);
            if (!rate.allowed) {
                return res.status(429).json({ ok: false, error: rate.message, errorType: 'rate_limit' });
            }
            const { username, cardCode } = req.body || {};
            if (!username) return res.status(400).json({ ok: false, error: '请提供用户名' });
            if (!cardCode) return res.status(400).json({ ok: false, error: '请提供卡密' });

            const result = userStore.renewUser(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);

            adminLogger.info('公开续费成功', { username, cardType: result.cardType, ip });
            for (const [token, session] of ctx.sessions.entries()) {
                if (session.username === String(username)) {
                    session.subscription = result.subscription;
                    session.card = result.subscription;
                    session.accountLimit = result.accountLimit;
                    ctx.sessions.set(token, session);
                }
            }
            return res.json({
                ok: true,
                data: {
                    subscription: result.subscription,
                    accountLimit: result.accountLimit,
                    cardType: result.cardType,
                    summary: result.summary,
                },
            });
        } catch (error: any) {
            adminLogger.error('公开续费失败', { error: error.message });
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 找回密码：校验用户名与卡密归属 */
    app.post('/api/public/reset-password/verify', (req: Request, res: Response) => {
        try {
            if (!USER_SYSTEM_CONFIG.allowPublicResetPassword) {
                return res.status(403).json({ ok: false, error: '未开放找回密码' });
            }
            const ip = getClientIp(req);
            const rate = userStore.checkRateLimit(ip);
            if (!rate.allowed) {
                return res.status(429).json({ ok: false, error: rate.message, errorType: 'rate_limit' });
            }
            const { username, cardCode } = req.body || {};
            if (!username || !cardCode) {
                return res.status(400).json({ ok: false, error: '请提供用户名和卡密' });
            }
            const result = userStore.verifyCardOwnership(String(username), String(cardCode));
            if (!result.ok) return res.status(400).json(result);
            return res.json({ ok: true });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 找回密码：确认重置 */
    app.post('/api/public/reset-password/confirm', (req: Request, res: Response) => {
        try {
            if (!USER_SYSTEM_CONFIG.allowPublicResetPassword) {
                return res.status(403).json({ ok: false, error: '未开放找回密码' });
            }
            const ip = getClientIp(req);
            const rate = userStore.checkRateLimit(ip);
            if (!rate.allowed) {
                return res.status(429).json({ ok: false, error: rate.message, errorType: 'rate_limit' });
            }
            const { username, cardCode, newPassword } = req.body || {};
            if (!username || !cardCode || !newPassword) {
                return res.status(400).json({ ok: false, error: '请提供用户名、卡密和新密码' });
            }
            const result = userStore.resetPasswordByCard(String(username), String(cardCode), String(newPassword));
            if (!result.ok) return res.status(400).json(result);
            adminLogger.info('找回密码重置成功', { username, ip });
            return res.json({ ok: true, message: result.message });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 免费卡密自助领取（仅描述为「免费」的加时卡，仅供注册新账号） */
    app.post('/api/card-claim/claim', (req: Request, res: Response) => {
        try {
            const userAgent = String(req.headers['user-agent'] || '');
            const username = (req.body as any)?.username || null;
            const ip = getClientIp(req);
            const claim = userStore.claimCardByUA(userAgent, username, ip);
            if (!claim.ok) {
                const payload: any = { ok: false, error: claim.error };
                if (claim.remainingMs) payload.remainingMs = claim.remainingMs;
                return res.status(400).json(payload);
            }
            return res.json({ ok: true, cardCode: claim.cardCode, description: claim.description, valueText: claim.valueText });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 卡密领取开关状态 */
    app.get('/api/card-claim/status', (_req: Request, res: Response) => {
        try {
            const status = userStore.getCardClaimStatus();
            return res.json({ ok: true, ...status });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 我的核销记录（只含当前账号生命周期内的记录） */
    app.get('/api/user/redemptions', authRequired, (req: Request, res: Response) => {
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        const limit = Number.parseInt(req.query.limit as string) || 50;
        const me = userStore.getUserByName(username);
        const since = me && me.createdAt ? Number(me.createdAt) || 0 : 0;
        const result = userStore.getRedemptions({ username, limit, since });
        return res.json({ ok: true, data: result });
    });

    /** 我的邀请码 */
    app.get('/api/user/invite', authRequired, (req: Request, res: Response) => {
        const username = (req as any).currentUser?.username;
        if (!username) return res.status(401).json({ ok: false, error: '未登录' });
        try {
            return res.json({ ok: true, data: inviteService.getUserSummary(username) });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    /** 注册页预览邀请码是否有效（不消耗、不记流水） */
    app.get('/api/public/invite/preview', (req: Request, res: Response) => {
        try {
            const code = String((req.query as any).code || '');
            const settings = inviteService.getSettings();
            if (!settings.enabled) {
                return res.json({ ok: true, data: { valid: false, reason: 'disabled' } });
            }
            const found = inviteService.findInviterByCode(code);
            if (!found) {
                return res.json({ ok: true, data: { valid: false, reason: 'code_not_found' } });
            }
            return res.json({
                ok: true,
                data: {
                    valid: true,
                    inviter: found.username,
                    inviteeDays: settings.inviteeDays,
                    inviterDays: settings.inviterDays,
                },
            });
        } catch (error: any) {
            return res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.use('/api', (req: Request, res: Response, next: any) => {
        const path = req.path;
        const publicExact = new Set([
            '/login',
            '/register',
            '/game-version',
            '/ping',
            '/card-claim/status',
            '/card-claim/claim',
        ]);
        const publicPrefixes = [
            '/card/info/',
            '/public/renew',
            '/public/account-status',
            '/public/reset-password/',
            '/public/invite/',
            // 抓包根 CA 证书下载：手机直接访问（flowId + token 自鉴权，无需面板会话）
            '/public/capture-certificate/',
        ];
        if (publicExact.has(path)) return next();
        if (publicPrefixes.some(prefix => path.startsWith(prefix))) return next();
        return authRequired(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version });
    });

    app.get('/api/auth/validate', (req: any, res: Response) => {
        // 验证同时返回角色信息，前端路由守卫据此决定是否放行管理后台
        const token = String(req.headers['x-admin-token'] || '');
        const session = token ? ctx.sessions.get(token) : null;
        const rejection = session
            ? (require('./middleware').getSessionRejection(session))
            : { reason: 'no_session', error: 'Unauthorized' };
        if (!session || rejection) {
            return res.status(401).json({ ok: false, error: rejection?.error || 'Unauthorized' });
        }
        res.json({
            ok: true,
            data: {
                valid: true,
                role: session.role,
                username: session.username,
                coinRankVisibility: store.getCoinRankVisibility(),
            },
        });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken || String(req.headers['x-admin-token'] || '');
        if (token) {
            ctx.tokens.delete(token);
            ctx.sessions.delete(token);
        }
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: any, res: Response) => {
        const currentUser = req.currentUser;
        if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });

        const subscription = currentUser.subscription || currentUser.card || null;
        const accounts = ctx.provider && typeof ctx.provider.getAccounts === 'function'
            ? ctx.provider.getAccounts().accounts || []
            : [];
        const accountCount = isElevatedRole(currentUser.role)
            ? accounts.length
            : accounts.filter((account: any) =>
                String(account.owner || account.username || '') === String(currentUser.username)).length;
        const limit = Number(currentUser.accountLimit);
        const unlimited = isElevatedRole(currentUser.role) || limit === -1;
        // session 不含 email/nick，现查用户资料（超管来自 env 时可能无记录，回退空串）
        const profile = userStore.getUserByName(currentUser.username);

        res.json({
            ok: true,
            data: {
                username: currentUser.username,
                role: currentUser.role,
                coinRankVisibility: store.getCoinRankVisibility(),
                nick: profile?.nick || '',
                email: profile?.email || '',
                card: subscription,
                subscription,
                accountLimit: currentUser.accountLimit,
                accountCount,
                accountRemaining: unlimited ? -1 : Math.max(0, (Number.isFinite(limit) ? limit : 0) - accountCount),
                isExpired: subscription ? userStore.isSubscriptionExpired(subscription) : false,
                remainingMs: subscription ? userStore.getRemainingMs(subscription) : 0,
                mustChangePassword: currentUser.mustChangePassword === true,
                allowRegister: USER_SYSTEM_CONFIG.allowRegister === true,
                allowPublicRenew: USER_SYSTEM_CONFIG.allowPublicRenew === true,
                allowPublicResetPassword: USER_SYSTEM_CONFIG.allowPublicResetPassword === true,
            },
        });
    });

    /** 用户自助更新个人资料（目前仅收件邮箱）：白名单字段，不能改角色/额度/密码 */
    app.post('/api/user/profile', (req: any, res: Response) => {
        const currentUser = req.currentUser;
        if (!currentUser || !currentUser.username)
            return res.status(401).json({ ok: false, error: '未登录' });

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const rawEmail = String(body.email ?? '').trim();
        if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))
            return res.status(400).json({ ok: false, error: '邮箱格式不正确' });

        // 只信任会话里的用户名，绝不接收前端传来的 username，避免越权改他人资料
        const result = userStore.editUser(currentUser.username, { email: rawEmail });
        if (!result || result.ok === false)
            return res.status(400).json({ ok: false, error: (result && result.error) || '保存失败' });

        return res.json({ ok: true, data: { email: rawEmail } });
    });
}

module.exports = { mountAuthRoutes };
