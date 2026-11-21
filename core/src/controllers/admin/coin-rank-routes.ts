import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 金币排行榜路由：聚合当前用户可见的全部农场账号的「今日金币增加」并降序排名。
 * 今日增量取自各账号运行时的 todayGoldGained（由 services/stats 按日基线计算），
 * 避免重复实现统计口径。离线账号无实时增量，按 0 处理并保留在榜单中。
 */

const store = require('../../models/store');
const { isSuperAdminRole } = require('../../config/user-system');
const { getTodayKey } = require('../../services/stats');
const {
    handleApiError,
    createRequireAdminRole,
} = require('./middleware');

interface AuthenticatedRequest extends Request {
    currentUser?: any;
}

function toFiniteNumber(value: any): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function mountCoinRankRoutes(app: Application, ctx: AdminContext): void {
    const requireAdminRole = createRequireAdminRole(ctx);

    // API: 读取排行榜可见范围（所有登录用户可读，供前端菜单/路由守卫联动）
    app.get('/api/coin-rank/visibility', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: { visibility: store.getCoinRankVisibility() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 后台设置排行榜可见范围（仅超级管理员）
    app.get('/api/admin/coin-rank-visibility', requireAdminRole, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: { visibility: store.getCoinRankVisibility() } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/coin-rank-visibility', requireAdminRole, (req: Request, res: Response) => {
        try {
            const raw = (req.body || {}).visibility;
            const visibility = store.setCoinRankVisibility(raw);
            res.json({ ok: true, data: { visibility } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 今日金币增加排行榜（跨账号聚合）
    app.get('/api/coin-rank', (req: Request, res: Response) => {
        try {
            const user = (req as AuthenticatedRequest).currentUser || null;
            const isSuper = !!(user && isSuperAdminRole(user.role));

            // 可见范围控制：设置为「仅超级管理员可见」时，普通用户禁止访问榜单数据。
            if (!isSuper && store.getCoinRankVisibility() === 'super_admin') {
                return res.status(403).json({ ok: false, error: '排行榜仅超级管理员可见' });
            }

            const data = ctx.provider.getAccounts();
            // 排行榜可见范围独立于账号列表可见性开关：
            // 「全员可见」模式下所有登录用户均看到全部账号的完整榜单，便于横向对比。
            const accounts: any[] = Array.isArray(data?.accounts) ? data.accounts : [];

            const list = accounts.map((account: any) => {
                const accountId = String(account.id || '');
                let status: any = null;
                try {
                    status = ctx.provider.getStatus(accountId);
                } catch {
                    status = null;
                }
                const liveAvatar = String(status?.status?.avatarUrl || '').trim();
                const avatar = liveAvatar || String(account.avatar || '').trim();
                const todayGoldGained = toFiniteNumber(status?.todayGoldGained);
                return {
                    id: accountId,
                    // 备注名优先，缺省回退游戏昵称 / QQ 号 / 账号 ID
                    name: String(account.name || '').trim()
                        || String(account.nick || '').trim()
                        || String(account.uin || account.qq || '').trim()
                        || accountId,
                    nick: String(account.nick || status?.status?.name || '').trim(),
                    avatar,
                    platform: String(account.platform || '').trim() || undefined,
                    running: !!account.running,
                    todayGoldGained,
                    gold: toFiniteNumber(status?.status?.gold),
                };
            });

            // 仅展示有有效增长的账号；相同增量时按当前金币数、名称稳定排序
            list.sort((a: any, b: any) => {
                if (b.todayGoldGained !== a.todayGoldGained)
                    return b.todayGoldGained - a.todayGoldGained;
                if (b.gold !== a.gold)
                    return b.gold - a.gold;
                return String(a.name).localeCompare(String(b.name), 'zh-CN');
            });

            const totalGoldGained = list.reduce((sum: number, item: any) => sum + item.todayGoldGained, 0);
            const ranked = list.map((item: any, index: number) => ({ ...item, rank: index + 1 }));

            res.json({
                ok: true,
                data: {
                    date: getTodayKey(),
                    updatedAt: Date.now(),
                    totalAccounts: ranked.length,
                    totalGoldGained,
                    list: ranked,
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountCoinRankRoutes };
