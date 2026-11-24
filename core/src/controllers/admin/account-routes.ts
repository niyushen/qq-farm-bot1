import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const wxCredentialGuard = require('../../services/wx-credential-guard');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
    canAccessAccount,
    isAccountOwner,
    createRequireAdminRole,
} = require('./middleware');
const userStore = require('../../models/user-store');
const featuresStore = require('../../models/user-features-store');
const inviteRewards = require('../../services/invite-rewards');
const { isSuperAdminRole } = require('../../config/user-system');

interface AuthenticatedRequest extends Request {
    currentUser?: any;
}

function mountAccountRoutes(app: Application, ctx: AdminContext): void {
    const requireAdminRole = createRequireAdminRole(ctx);

    // 普通用户是否可见全部农场账号（默认关闭：普通用户只能看到自己添加的账号）
    app.get('/api/admin/account-visibility', requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: { usersSeeAllAccounts: store.getUsersSeeAllAccounts() } });
        } catch (error: any) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/admin/account-visibility', requireAdminRole, (req: Request, res: Response) => {
        try {
            const enabled = (req.body || {}).usersSeeAllAccounts === true;
            const saved = store.setUsersSeeAllAccounts(enabled);
            res.json({ ok: true, data: { usersSeeAllAccounts: saved } });
        } catch (error: any) {
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const data = ctx.provider.getAccounts();
            const user = (req as AuthenticatedRequest).currentUser || null;
            // 多用户归属过滤：普通用户默认只能看到自己的账号；
            // 管理员开启「普通用户可见全部账号」后，普通用户也可看到全部账号（操作权限仍受归属校验约束）
            if (user && !isSuperAdminRole(user.role) && !store.getUsersSeeAllAccounts() && Array.isArray(data?.accounts)) {
                data.accounts = data.accounts.filter((account: any) => isAccountOwner(account, user));
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx, (req as AuthenticatedRequest).currentUser || null);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/accounts', async (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '账号备注不能为空' });
            }
            // 前端扫码/填码登录完成后带 startAfterSave: true，保存后直接启动账号，无需回列表手动点启动
            const startAfterSave = body.startAfterSave === true;
            delete (body as any).startAfterSave;
            const currentUser = (req as AuthenticatedRequest).currentUser || null;
            const visibleAccounts = getAccountList(ctx, currentUser);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef, currentUser) : '';
            // 更新已有账号时校验归属：普通用户不能改别人的账号
            if (isUpdate && !canAccessAccount(ctx, req, resolvedUpdateId || updateRef)) {
                return res.status(403).json({ ok: false, error: '无权操作该账号' });
            }
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body;

            // 新增账号时校验额度：额度卡可提升上限，超级管理员不受限制（-1 表示不限）
            if (!isUpdate && currentUser && !isSuperAdminRole(currentUser.role)) {
                const quota = userStore.checkAccountQuota(currentUser, visibleAccounts.length);
                if (!quota.ok) {
                    return res.status(403).json({ ok: false, error: quota.error, quota });
                }
            }
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            // 创建账号时写入归属（owner），普通用户与超管创建都记录创建者
            if (!isUpdate && currentUser) {
                const ownerName = String(currentUser.username || '').trim();
                if (ownerName) (payload as any).owner = ownerName;
            }

            const data = addOrUpdateAccount(payload);
            // 只有真正保存了新的 loginBuffer 才算接受了一次新扫码；token 轮换
            // 或改备注不会带这个字段，因此不会错误推进扫码代次。
            if (payload.loginBuffer) {
                const savedId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                if (savedId) wxCredentialGuard.noteAcceptedScan(savedId);
            }
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRemarkRelogin
                        ? `通过备注重新登录账号: ${accountName || accountId}`
                        : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc) {
                    await ctx.provider.startAccount(newAcc.id);
                    // 微信账号：按当前配置（含默认迁移标记）重建定时刷新/保活调度
                    if (typeof (ctx.provider as any).scheduleAutoCodeRefresh === 'function') {
                        (ctx.provider as any).scheduleAutoCodeRefresh(String(newAcc.id));
                    }
                }
                // 新号第一次绑定挂机账号 → 结算邀请人的待定奖励（失败不影响建号）
                if (currentUser && currentUser.username) {
                    try {
                        const createdAccount = newAcc || payload;
                        inviteRewards.markInviteeBound(currentUser.username, userStore, inviteRewards.identityFromAccount(createdAccount || {}));
                    } catch (error: any) {
                        if (ctx.provider.addAccountLog) {
                            ctx.provider.addAccountLog('info', `邀请奖励结算失败: ${error?.message || error}`, '', '');
                        }
                    }
                }
            } else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                await ctx.provider.restartAccount(payload.id);
            } else if (!onlyRemarkChanged && (wasRunning || startAfterSave)) {
                // 更新账号：之前在运行或前端要求登录后自动启动（扫码/填码重新登录），则重启/启动
                if (wasRunning)
                    await ctx.provider.restartAccount(payload.id);
                else
                    await ctx.provider.startAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/accounts/:id', async (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id, (req as AuthenticatedRequest).currentUser || null) || String(req.params.id || '');

            // 归属检查：普通用户不能删除别人的账号
            if (!canAccessAccount(ctx, req, resolvedId)) {
                return res.status(403).json({ ok: false, error: '无权操作该账号' });
            }

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            await ctx.provider.stopAccount(resolvedId);
            // 清掉该账号的定时刷新/保活/重登调度
            if (typeof (ctx.provider as any).stopAutoCodeRefresh === 'function') {
                (ctx.provider as any).stopAutoCodeRefresh(resolvedId);
            }
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(req.query.limit as string) || 100;
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 用户隔离：普通用户只能看到自己账号的操作日志
            const logUser = (req as AuthenticatedRequest).currentUser || null;
            if (logUser && !isSuperAdminRole(logUser.role)) {
                const ownedIds = new Set(getAccountList(ctx, logUser).map((a: any) => String(a.id || '')).filter(Boolean));
                list = list.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));
            }

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 日志
    /**
     * 三处日志查询分支共用同一份查询条件构造，避免新增字段时漏改。
     * space：ranch/farm 指定空间；不传则两池合并。
     */
    const buildLogOptions = (req: Request) => ({
        limit: Number.parseInt(req.query.limit as string) || 100,
        tag: req.query.tag || '',
        module: req.query.module || '',
        event: req.query.event || '',
        keyword: req.query.keyword || '',
        isWarn: req.query.isWarn,
        timeFrom: req.query.timeFrom || '',
        timeTo: req.query.timeTo || '',
        space: req.query.space || '',
    });

    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const logUser = (req as AuthenticatedRequest).currentUser || null;
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw, logUser)) : getAccId(ctx, req);
        // 指定 accountId=all 时仍需归属检查：普通用户不能拉取全部账号日志
        if (queryAccountIdRaw === 'all' && logUser && !isSuperAdminRole(logUser.role)) {
            const accounts = getAccountList(ctx, logUser);
            const accountIds = accounts.map((a: any) => String(a.id || '')).filter(Boolean);
            const allLogs: any[] = [];
            const options = buildLogOptions(req);
            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) allLogs.push(...logs);
            }
            // ts 是数值时间戳；time 是字符串，直接相减得 NaN 会让排序失效
            allLogs.sort((a: any, b: any) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0));
            return res.json({ ok: true, data: allLogs.slice(0, options.limit) });
        }
        // 如果没有指定账号ID，获取所有账号的日志
        if (!id) {
            const accountIds = getAccountIds(ctx, (req as AuthenticatedRequest).currentUser || null);
            const allLogs: any[] = [];
            const options = buildLogOptions(req);

            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a: any, b: any) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = buildLogOptions(req);
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id, { space: (req.query.space || '').toString() });

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                // 快照按空间分推（前端按 space 分别替换对应缓冲）
                for (const space of ['ranch', 'farm']) {
                    const accountLogs = ctx.provider.getLogs(id, { limit: 100, space });
                    ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                        accountId: id,
                        space,
                        logs: Array.isArray(accountLogs) ? accountLogs : [],
                    });

                    let allLogs = ctx.provider.getLogs('', { limit: 100, space });
                    if (!Array.isArray(allLogs)) allLogs = [];
                    // 用户隔离：聚合视图（account:all）按归属过滤，避免普通用户收到他人账号日志
                    const currentUser = (req as AuthenticatedRequest).currentUser || null;
                    if (currentUser) {
                        const ownedIds = new Set(getAccountList(ctx, currentUser).map((a: any) => String(a.id || '')).filter(Boolean));
                        allLogs = allLogs.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));
                    }
                    ctx.io.to('account:all').emit('logs:snapshot', {
                        accountId: 'all',
                        space,
                        logs: allLogs,
                    });
                }
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        // 归属检查：普通用户只能保存自己账号的配置
        if (!canAccessAccount(ctx, req, id)) {
            return res.status(403).json({ ok: false, error: '无权操作该账号' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置面板主题（全局 UI 状态，仅超级管理员可写）
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        const themeUser = (req as AuthenticatedRequest).currentUser || null;
        if (!themeUser || !isSuperAdminRole(themeUser.role)) {
            return res.status(403).json({ ok: false, error: '仅超级管理员可修改全局主题' });
        }
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存下线提醒配置（按登录用户隔离存储；所有登录用户可保存自己的配置）
    app.post('/api/settings/offline-reminder', async (req: Request, res: Response) => {
        const reminderUser = (req as AuthenticatedRequest).currentUser || null;
        if (!reminderUser) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const channel = String(body.channel || '').trim().toLowerCase();
            if (channel === 'dingtalk') {
                try {
                    const { buildDingTalkWebhook } = require('../../services/push');
                    buildDingTalkWebhook(body.endpoint, body.token, body.secret);
                } catch (error: any) {
                    return res.status(400).json({ ok: false, error: error?.message || '钉钉 Webhook 地址格式无效' });
                }
            }
            const data = store.setOfflineReminder ? store.setOfflineReminder(body, reminderUser.username) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 测试下线提醒推送（不落盘；所有登录用户可测试自己的配置，合并已保存内容）
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        const testUser = (req as AuthenticatedRequest).currentUser || null;
        if (!testUser) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder(testUser.username) : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }

            // SMTP 邮件渠道：勾选「使用管理员配置的邮件服务」时复用全局 SMTP
            if (channel === 'smtp') {
                let smtpHost = String(cfg.smtpHost || '').trim();
                let smtpUser = String(cfg.smtpUser || '').trim();
                let smtpPass = String(cfg.smtpPass || '').trim();
                let senderName = String(cfg.senderName || '').trim();
                let smtpPort = Number(cfg.smtpPort) || 465;
                const useGlobalMailer = cfg.useGlobalMailer === true;
                if (useGlobalMailer) {
                    const globalMailer = featuresStore.getGlobalMailer();
                    if (!globalMailer || globalMailer.ready !== true) {
                        return res.status(400).json({ ok: false, error: '管理员尚未配置好后台邮件服务，请先联系管理员或在下方自行填写 SMTP' });
                    }
                    smtpHost = globalMailer.smtpHost;
                    smtpPort = globalMailer.smtpPort;
                    smtpUser = globalMailer.smtpUser;
                    smtpPass = globalMailer.smtpPass;
                    senderName = globalMailer.senderName || senderName;
                }
                if (!smtpHost) {
                    return res.status(400).json({ ok: false, error: 'SMTP 渠道需要填写服务器地址' });
                }
                if (!smtpUser) {
                    return res.status(400).json({ ok: false, error: 'SMTP 渠道需要填写邮箱账号' });
                }
                if (!smtpPass) {
                    return res.status(400).json({ ok: false, error: 'SMTP 渠道需要填写授权码' });
                }
                if (!String(cfg.recipientEmail || '').trim()) {
                    return res.status(400).json({ ok: false, error: 'SMTP 渠道需要填写收件人邮箱' });
                }
                const { sendSmtpEmail } = require('../../services/push');
                const ret = await sendSmtpEmail({
                    smtpHost,
                    smtpPort,
                    smtpUser,
                    smtpPass,
                    senderName,
                    recipientEmail: cfg.recipientEmail,
                    subject: `${titleBase}（测试）`,
                    content: useGlobalMailer
                        ? '这是一封测试邮件，收到它说明后台全局邮件服务配置成功！'
                        : `${msgBase}\n\n这是一条下线提醒测试邮件。\n时间: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
                });
                if (!ret?.ok) {
                    return res.status(400).json({ ok: false, error: ret?.msg || '测试邮件发送失败', data: ret });
                }
                return res.json({ ok: true, data: ret, message: ret.msg || '测试邮件发送成功' });
            }

            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '钉钉渠道需要填写 Webhook 地址' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: '当前推送渠道需要填写 Token' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }

            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';

            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedMultiLandReservationEnabled = id && (typeof store.getBagSeedMultiLandReservationEnabled === 'function') ? store.getBagSeedMultiLandReservationEnabled(id) : false;
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const autoCodeRefresh = id && (typeof store.getAutoCodeRefresh === 'function') ? store.getAutoCodeRefresh(id) : { enabled: false, intervalMinutes: 60 };
            // 黄金虫策略（保留数量/单轮上限）取自账号配置快照
            const goldenBugSnapshot: any = id && (typeof store.getConfigSnapshot === 'function') ? store.getConfigSnapshot(id) : {};
            const goldenBugKeepCount = Number(goldenBugSnapshot.goldenBugKeepCount ?? 0);
            const goldenBugRoundLimit = Number(goldenBugSnapshot.goldenBugRoundLimit ?? 24);
            const ui = store.getUI();
            // 下线提醒按登录用户隔离：返回当前用户自己的配置（未配置时返回默认值）
            const settingsUser = (req as AuthenticatedRequest).currentUser || null;
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder(settingsUser ? settingsUser.username : '')
                : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            // 管理员是否配置好全局邮件服务（用户在通知设置里可勾选复用，免填 SMTP）
            const globalMailer = typeof featuresStore.getGlobalMailerPublic === 'function'
                ? featuresStore.getGlobalMailerPublic()
                : { available: false, senderName: '' };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, goldenBugKeepCount, goldenBugRoundLimit, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedMultiLandReservationEnabled, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, autoCodeRefresh, ui, offlineReminder, globalMailer } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 管理员全局邮件服务公开状态（与账号无关，通知设置页未选账号时也能判断开关可用性）
    app.get('/api/settings/mailer', (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: typeof featuresStore.getGlobalMailerPublic === 'function'
                    ? featuresStore.getGlobalMailerPublic()
                    : { available: false, senderName: '' },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 保存微信定时刷新重登配置（按账号保存；启用后立即重建该账号的调度）
    app.post('/api/settings/auto-code-refresh', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        // 归属检查：普通用户只能改自己的账号
        if (!canAccessAccount(ctx, req, id)) {
            return res.status(403).json({ ok: false, error: '无权操作该账号' });
        }
        try {
            const body = req.body || {};
            const saved = store.setAutoCodeRefresh(id, {
                enabled: body.enabled === true,
                intervalMinutes: Math.max(1, Math.min(1440, Number(body.intervalMinutes) || 60)),
            });
            // 调度幂等：按新配置重建该账号的刷新/保活任务
            if (typeof (ctx.provider as any).scheduleAutoCodeRefresh === 'function') {
                (ctx.provider as any).scheduleAutoCodeRefresh(id);
            }
            res.json({ ok: true, data: saved });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 手动立即刷新微信 Code（仅带凭证的微信账号有效）
    app.post('/api/settings/auto-code-refresh/refresh', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }
        if (!canAccessAccount(ctx, req, id)) {
            return res.status(403).json({ ok: false, error: '无权操作该账号' });
        }
        try {
            if (typeof (ctx.provider as any).refreshAccountCode !== 'function') {
                return res.status(501).json({ ok: false, error: '当前运行模式不支持手动刷新' });
            }
            const ok = await (ctx.provider as any).refreshAccountCode(id, 'manual');
            res.json({ ok, error: ok ? undefined : '刷新失败，请检查网络或重新扫码登录' });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/system-config', (req: Request, res: Response) => {
        // 仅超级管理员可读：返回值含 NapCat 接口签名等机密（与 GET /api/settings/login-config 的脱敏逻辑保持一致）
        const systemConfigUser = (req as AuthenticatedRequest).currentUser || null;
        if (!systemConfigUser || !isSuperAdminRole(systemConfigUser.role)) {
            return res.status(403).json({ ok: false, error: '仅超级管理员可查看全局设置' });
        }
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                    loginSettings: store.getLoginSettings
                        ? store.getLoginSettings()
                        : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' },
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/settings/login-config', (req: Request, res: Response) => {
        try {
            const loginSettings = store.getLoginSettings
                ? store.getLoginSettings()
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            // 用户隔离：NapCat 服务地址与签名密钥仅超级管理员可见（普通用户只需开关状态）
            const loginConfigUser = (req as AuthenticatedRequest).currentUser || null;
            if (!loginConfigUser || !isSuperAdminRole(loginConfigUser.role)) {
                return res.json({ ok: true, data: { wechatQrLogin: loginSettings.wechatQrLogin, qqQrLogin: loginSettings.qqQrLogin, napCatEndpoint: '', napCatSignature: '' } });
            }
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 全局登录方式配置：仅超级管理员可修改
    app.post('/api/settings/login-config', (req: Request, res: Response) => {
        const currentUser = (req as AuthenticatedRequest).currentUser || null;
        if (!currentUser || !isSuperAdminRole(currentUser.role)) {
            return res.status(403).json({ ok: false, error: '仅超级管理员可修改登录设置' });
        }
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const loginSettings = store.setLoginSettings
                ? store.setLoginSettings({
                    wechatQrLogin: body.wechatQrLogin,
                    qqQrLogin: body.qqQrLogin,
                    napCatEndpoint: body.napCatEndpoint,
                    napCatSignature: body.napCatSignature,
                })
                : { wechatQrLogin: true, qqQrLogin: false, napCatEndpoint: '', napCatSignature: '' };
            res.json({ ok: true, data: loginSettings });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 全局运行环境配置：仅超级管理员可修改
    app.post('/api/settings/system-config', (req: Request, res: Response) => {
        const currentUser = (req as AuthenticatedRequest).currentUser || null;
        if (!currentUser || !isSuperAdminRole(currentUser.role)) {
            return res.status(403).json({ ok: false, error: '仅超级管理员可修改系统配置' });
        }
        try {
            const { serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo } = req.body || {};
            const saved = store.setSystemConfig({ serverUrl, clientVersion, wxClientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/settings/system-config/reset', (req: Request, res: Response) => {
        const currentUser = (req as AuthenticatedRequest).currentUser || null;
        if (!currentUser || !isSuperAdminRole(currentUser.role)) {
            return res.status(403).json({ ok: false, error: '仅超级管理员可重置系统配置' });
        }
        try {
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            // Keep live sessions intact. A new login must use a fresh one-time Code.
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountAccountRoutes };
