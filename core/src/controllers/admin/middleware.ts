import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { USER_SYSTEM_CONFIG, USER_ROLES, isElevatedRole, isSuperAdminRole } = require('../../config/user-system');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    currentUser?: any;
}

/**
 * 是否信任反向代理注入的客户端 IP 头。
 * 默认关闭：服务器直接对公网部署时，cf-connecting-ip / x-real-ip / x-forwarded-for
 * 均由客户端任意伪造，若信任它们，登录/注册等接口的 IP 限速可被绕过。
 * 部署在可信反代（nginx / Cloudflare）之后时，设置 FARM_TRUST_PROXY_HEADERS=true 启用。
 */
const TRUST_PROXY_HEADERS = process.env.FARM_TRUST_PROXY_HEADERS === 'true'
    || process.env.FARM_TRUST_PROXY_HEADERS === '1';

function getClientIp(req: Request): string {
    if (TRUST_PROXY_HEADERS) {
        const cfIp = req.headers['cf-connecting-ip'];
        if (cfIp) return String(cfIp).trim();
        const realIp = req.headers['x-real-ip'];
        if (realIp) return String(realIp).trim();
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
            if (first) return first;
        }
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

/** 账号归属字段：优先 owner，兼容旧数据使用 username */
function getAccountOwner(account: any): string {
    if (!account) return '';
    const owner = String(account.owner || '').trim();
    return owner || String(account.username || '').trim();
}

/** 判断账号是否归属于该登录用户（仅超级管理员视为全部归属） */
function isAccountOwner(account: any, user: any): boolean {
    if (!account || !user) return false;
    if (isSuperAdminRole(user.role)) return true;
    return getAccountOwner(account) === String(user.username || '').trim();
}

/** 会话复查：封禁 / 过期 / 会话超时（管理员豁免有效期检查） */
function getSessionRejection(session: any): { reason: string, error: string } | null {
    if (!session) return { reason: 'no_session', error: 'Unauthorized' };
    if (isElevatedRole(session.role)) return null;

    const subscription = session.subscription || session.card || null;
    if (subscription && subscription.enabled === false) {
        return { reason: 'disabled', error: '账号已被禁用，请联系管理员' };
    }
    if (subscription && userStore.isSubscriptionExpired(subscription)) {
        return { reason: 'expired', error: '账号已过期，请续费后重新登录' };
    }
    const ttl = Number(USER_SYSTEM_CONFIG.sessionTtlMs) || 0;
    if (ttl > 0 && session.createdAt && Date.now() - session.createdAt > ttl) {
        return { reason: 'timeout', error: '登录已超时，请重新登录' };
    }
    return null;
}

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        if (!token || !ctx.tokens.has(token)) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        const session = ctx.sessions.get(token) || null;
        const rejection = getSessionRejection(session);
        if (rejection) {
            ctx.tokens.delete(token);
            ctx.sessions.delete(token);
            res.status(403).json({
                ok: false,
                error: rejection.error,
                errorType: rejection.reason,
            });
            return;
        }
        req.adminToken = token;
        req.currentUser = session;
        next();
    };
}

/** 管理权限（超级管理员） */
function createRequireAdminRole(ctx: AdminContext) {
    void ctx;
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const user = req.currentUser;
        if (!user) {
            res.status(401).json({ ok: false, error: '未登录' });
            return;
        }
        if (!isElevatedRole(user.role)) {
            res.status(403).json({ ok: false, error: '需要管理员权限' });
            return;
        }
        next();
    };
}

const createRequireSuperAdminRole = createRequireAdminRole;

/** 危险操作确认：请求必须携带 confirmed: true（配合前端二次确认弹窗） */
function requireDangerConfirmation(req: AuthenticatedRequest, res: Response, action: string): boolean {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const query = req.query || {};
    const confirmed = body.confirmed === true || query.confirmed === 'true' || query.confirmed === '1';
    if (!confirmed) {
        res.status(400).json({
            ok: false,
            error: `危险操作「${action}」需要二次确认`,
            needConfirm: true,
            action,
        });
        return false;
    }
    return true;
}

/**
 * 普通管理员不能增删改其他管理员账号。
 * 返回错误文案；null 表示放行。
 */
function getAdminUserMutationError(currentUser: any, targetUsername: unknown): string | null {
    if (!currentUser) return '未登录';
    if (isSuperAdminRole(currentUser.role)) return null;
    const target = String(targetUsername || '').trim();
    const targetUser = userStore.getUserByName(target);
    if (targetUser && isElevatedRole(targetUser.role)) {
        return '普通管理员不能操作其他管理员账号';
    }
    return null;
}

function getAccountList(ctx: AdminContext, user: any = null): any[] {
    let accounts: any[] = [];
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) accounts = data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    if (!accounts.length) {
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        accounts = Array.isArray(data.accounts) ? data.accounts : [];
    }
    // 多用户归属过滤：普通用户只能看到自己的账号
    if (user && !isSuperAdminRole(user.role)) {
        accounts = accounts.filter((account: any) => isAccountOwner(account, user));
    }
    return accounts;
}

function getAccountIds(ctx: AdminContext, user: any = null): string[] {
    return getAccountList(ctx, user).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    const hasServicePrefix = /^(?:[\w-]+\.)+[\w-]+/.test(message);
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || (hasServicePrefix && /\bcode=\d+\b/.test(message));
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    const codeMatch = message.match(/\bcode=\d+\b/);
    if (!codeMatch) return '';
    return message.slice((codeMatch.index ?? 0) + codeMatch[0].length).trim();
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any, user: any = null): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    const isElevated = !user || isSuperAdminRole(user.role);
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider && (isElevated || isAccountOwner(findAccountById(getAccountList(ctx, user), resolvedByProvider), user))) {
            return resolvedByProvider;
        }
    }
    const resolved = resolveAccountId(getAccountList(ctx, user), input);
    if (resolved) return resolved;
    // 用户隔离：普通用户只能解析自己名下的账号；解析不到（如传了别人的账号 ID）时
    // 返回空让路由拒绝，绝不能原样返回输入值（否则会越权操作他人账号）
    return isElevated ? input : '';
}

function findAccountById(accounts: any[], id: string): any | null {
    return accounts.find((account: any) => String(account.id) === String(id)) || null;
}

function getAccId(ctx: AdminContext, req: Request): string {
    const currentUser = (req as AuthenticatedRequest).currentUser || null;
    return resolveAccId(ctx, req.headers['x-account-id'], currentUser);
}

/** 校验请求指定的账号是否归属于当前登录用户（路由内调用） */
function canAccessAccount(ctx: AdminContext, req: Request, accountId: unknown): boolean {
    const currentUser = (req as AuthenticatedRequest).currentUser;
    if (!currentUser) return false;
    if (isSuperAdminRole(currentUser.role)) return true;
    const targetId = String(accountId || '').trim();
    if (!targetId) return false;
    const account = findAccountById(getAccountList(ctx, currentUser), targetId);
    return !!account;
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids(accountId),
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec(accountId),
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec(accountId),
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    createRequireAdminRole,
    createRequireSuperAdminRole,
    requireDangerConfirmation,
    getAdminUserMutationError,
    getAccountOwner,
    isAccountOwner,
    getSessionRejection,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    canAccessAccount,
    buildKnownFriendGidSettings,
    USER_ROLES,
};
