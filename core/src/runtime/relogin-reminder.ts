import type { PushNotification } from '../config/notification-types';
import { normalizeNotificationTypes } from '../config/notification-types';
import { readPushChannels } from '../config/push-channels';
const { sendPushChannels } = require('../services/push');

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    sendSmtpEmail?: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
    username?: string;
}

type PushPayload = {
    candidates?: PushNotification[];
    title?: string;
    content?: string;
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
    username?: string;
    logLabel?: string;
};

function createReloginReminderService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;
    const sendSmtpEmail = options.sendSmtpEmail || null;

    function findAccount(accountId: string): any {
        try {
            const data = typeof store.getAccounts === 'function' ? store.getAccounts() : null;
            const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
            return accounts.find((acc: any) => String(acc.id) === String(accountId));
        } catch {
            return null;
        }
    }

    /** 解析账号归属用户名：优先取调用方传入，其次按账号 owner/username 解析 */
    function resolveUsername(accountId: string, fallback = ''): string {
        const direct = String(fallback || '').trim();
        if (direct) return direct;
        try {
            const account = findAccount(accountId);
            const owner = account ? String(account.owner || account.username || '').trim() : '';
            return owner;
        } catch {
            return '';
        }
    }

    function getOfflineAutoDeleteMs(): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    function resolveSmtpConfig(cfg: any): { ok: true; cfg: any } | { ok: false; reason: string } {
        if (!cfg) return { ok: false, reason: '未找到下线提醒配置' };
        const channel = String(cfg.channel || '').trim().toLowerCase();
        if (channel !== 'smtp') return { ok: false, reason: '当前渠道不是 SMTP' };
        // 勾选「使用管理员配置的邮件服务」时免校验 SMTP 账号密码
        if (cfg.useGlobalMailer !== true) {
            if (!String(cfg.smtpHost || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写服务器地址' };
            if (!String(cfg.smtpUser || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写邮箱账号' };
            if (!String(cfg.smtpPass || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写授权码' };
        }
        if (!String(cfg.recipientEmail || '').trim()) return { ok: false, reason: 'SMTP 渠道未填写收件人邮箱' };
        return { ok: true, cfg };
    }

    async function sendConfiguredPush(payload: PushPayload = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const username = resolveUsername(accountId, String(payload.username || ''));
        const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
        const enabled = normalizeNotificationTypes(cfg?.notificationTypes);
        // 同一轮仅发送第一条允许的提醒，优先保留原有的合并购买消息。
        const notification = payload.candidates
            ? payload.candidates.find(item => item && enabled[item.type] === true)
            : payload;
        if (!notification) return;
        const baseTitle = String(notification.title || '').trim();
        const baseContent = String(notification.content || '').trim();
        const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            if (!cfg) {
                log('错误', '未找到下线提醒配置');
                return;
            }
            if (!title || !baseContent) {
                log('错误', '推送标题或内容为空');
                return;
            }

            // 本地 SMTP 渠道：按用户配置发送邮件；用户自定义邮件正文只用于下线提醒。
            if (String(cfg.channel || '').trim().toLowerCase() === 'smtp') {
                const smtpCfg = resolveSmtpConfig(cfg);
                if (smtpCfg.ok === false) {
                    log('错误', smtpCfg.reason);
                    return;
                }
                if (!sendSmtpEmail) {
                    log('错误', 'SMTP 邮件发送组件不可用');
                    return;
                }
                let content = baseContent;
                if (!payload.candidates) {
                    const template = String(cfg.emailContent || '').trim() || baseContent;
                    content = `${accountName ? `${accountName}\n` : ''}${template}`;
                    if (payload.reason) content += `\n原因: ${payload.reason}`;
                    const minutes = Math.floor((Number(payload.offlineMs) || 0) / 60000);
                    if (minutes > 0) content += `\n离线时长: ${minutes} 分钟`;
                }
                if (!content.trim()) {
                    log('错误', 'SMTP 邮件内容为空');
                    return;
                }
                // 勾选「使用管理员配置的邮件服务」时复用全局 SMTP
                let smtpHost = cfg.smtpHost;
                let smtpPort = cfg.smtpPort;
                let smtpUser = cfg.smtpUser;
                let smtpPass = cfg.smtpPass;
                let senderName = cfg.senderName;
                if (cfg.useGlobalMailer === true) {
                    const featuresStore = require('../models/user-features-store');
                    const globalMailer = typeof featuresStore.getGlobalMailer === 'function' ? featuresStore.getGlobalMailer() : null;
                    if (!globalMailer || globalMailer.ready !== true) {
                        log('错误', '下线提醒使用了后台邮件服务，但管理员尚未配置好全局 SMTP');
                        return;
                    }
                    smtpHost = globalMailer.smtpHost;
                    smtpPort = globalMailer.smtpPort;
                    smtpUser = globalMailer.smtpUser;
                    smtpPass = globalMailer.smtpPass;
                    senderName = globalMailer.senderName || cfg.senderName;
                }
                const ret = await sendSmtpEmail({
                    smtpHost,
                    smtpPort,
                    smtpUser,
                    smtpPass,
                    senderName,
                    recipientEmail: cfg.recipientEmail,
                    subject: title,
                    content,
                });
                if (ret?.ok) {
                    log('系统', `${logLabel}邮件发送成功: ${accountName || accountId || baseTitle}`);
                } else {
                    log('错误', `${logLabel}邮件发送失败: ${ret?.msg || 'unknown'}`);
                }
                return;
            }

            const targets = readPushChannels(cfg).filter(entry => entry.enabled);
            if (!targets.length) {
                log('错误', '未启用已配置的推送渠道');
                return;
            }
            const results = await sendPushChannels(targets, { title, content: baseContent }, sendPushooMessage);
            for (const result of results) {
                const suffix = targets.length > 1 ? `（${result.channel}）` : '';
                if (result.ok) log('系统', `${logLabel}发送成功${suffix}: ${accountName || accountId || title}`);
                else log('错误', `${logLabel}发送失败${suffix}: ${result.msg}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');
            const username = resolveUsername(accountId, String(payload.username || ''));
            const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
            if (!cfg) {
                log('错误', `未找到下线提醒配置: 用户=${username || '(空)'}`);
                return;
            }
            if (cfg.notificationTypes?.offline === false) return;
            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason, username });
            const baseTitle = String(cfg.title || '').trim();
            const content = String(cfg.msg || '').trim();
            if (!baseTitle || !content) {
                log('错误', '下线提醒配置不完整');
                return;
            }

            await sendConfiguredPush({
                title: baseTitle,
                content,
                accountId,
                accountName,
                reason,
                offlineMs: Number(payload.offlineMs) || 0,
                username,
                logLabel: '下线提醒',
            });
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerOfflineReminder, sendConfiguredPush };
}

module.exports = { createReloginReminderService };
