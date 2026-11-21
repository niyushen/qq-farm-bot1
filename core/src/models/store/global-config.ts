import type { GlobalConfig, LoginSettings, OfflineReminder, SystemConfig, UIConfig } from '../../types/config';
export {};

const { DEFAULT_CLIENT_VERSION, DEFAULT_WX_CLIENT_VERSION, DEFAULT_TIME_ZONE, normalizeTimeZone, resolveClientVersionUpdatedAt } = require('../../config/config');

const sharedState = require('./shared-state');

const {
    PUSHOO_CHANNELS,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    globalConfig,
    normalizeAccountConfig,
    cloneAccountConfig,
    DEFAULT_ACCOUNT_CONFIG,
} = sharedState;

function normalizeOfflineReminder(input: unknown): OfflineReminder {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    // smtp 不属于 pushoo 渠道集合，单独放行
    const channel = (migratedChannel === 'smtp' || PUSHOO_CHANNELS.has(migratedChannel))
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const secret = (src.secret !== undefined && src.secret !== null)
        ? String(src.secret).trim()
        : DEFAULT_OFFLINE_REMINDER.secret;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    const smtpHost = (src.smtpHost !== undefined && src.smtpHost !== null)
        ? String(src.smtpHost).trim()
        : DEFAULT_OFFLINE_REMINDER.smtpHost;
    let smtpPort = Number.parseInt(src.smtpPort, 10);
    if (!Number.isFinite(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
        smtpPort = DEFAULT_OFFLINE_REMINDER.smtpPort;
    }
    const smtpUser = (src.smtpUser !== undefined && src.smtpUser !== null)
        ? String(src.smtpUser).trim()
        : DEFAULT_OFFLINE_REMINDER.smtpUser;
    const smtpPass = (src.smtpPass !== undefined && src.smtpPass !== null)
        ? String(src.smtpPass).trim()
        : DEFAULT_OFFLINE_REMINDER.smtpPass;
    const senderName = (src.senderName !== undefined && src.senderName !== null)
        ? String(src.senderName).trim()
        : DEFAULT_OFFLINE_REMINDER.senderName;
    const recipientEmail = (src.recipientEmail !== undefined && src.recipientEmail !== null)
        ? String(src.recipientEmail).trim()
        : DEFAULT_OFFLINE_REMINDER.recipientEmail;
    const emailContent = (src.emailContent !== undefined && src.emailContent !== null)
        ? String(src.emailContent).trim()
        : DEFAULT_OFFLINE_REMINDER.emailContent;
    // 使用管理员全局邮件服务（只有 SMTP 渠道才有意义）
    const useGlobalMailer = src.useGlobalMailer === true || src.useGlobalMailer === 'true';
    return {
        channel,
        endpoint,
        token,
        secret,
        title,
        msg,
        offlineDeleteSec,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPass,
        senderName,
        recipientEmail,
        emailContent,
        useGlobalMailer,
    };
}

function saveGlobalConfig(changes: Partial<GlobalConfig> = {}): void {
    const next = { ...globalConfig, ...changes };
    const fallback = normalizeAccountConfig(next.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    next.defaultAccountConfig = cloneAccountConfig(fallback);
    // Publish memory only after persistence succeeds. Account documents have their
    // own write path, so a global setting never scans or serializes all accounts.
    sharedState.configStorage.saveGlobal(next);
    Object.assign(globalConfig, next);
    sharedState.accountFallbackConfig = fallback;
}

function getUI(): UIConfig {
    return { ...globalConfig.ui };
}

function setUITheme(theme: unknown): UIConfig {
    const t = String(theme || '').toLowerCase();
    const next: UIConfig['theme'] = (t === 'light') ? 'light' : 'dark';
    saveGlobalConfig({ ui: { ...globalConfig.ui, theme: next } });
    return getUI();
}

function getOfflineReminder(username?: unknown): OfflineReminder {
    const name = String(username || '').trim();
    if (!name) {
        return normalizeOfflineReminder(globalConfig.offlineReminder);
    }
    // 按登录用户隔离：优先读用户自己的配置，没有则返回默认值
    const userReminder = globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[name];
    if (userReminder) {
        return normalizeOfflineReminder(userReminder);
    }
    return normalizeOfflineReminder({});
}

function normalizeLoginSettings(input: unknown): LoginSettings {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    return {
        wechatQrLogin: typeof src.wechatQrLogin === 'boolean' ? src.wechatQrLogin : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
        qqQrLogin: typeof src.qqQrLogin === 'boolean' ? src.qqQrLogin : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
        napCatEndpoint: typeof src.napCatEndpoint === 'string' ? src.napCatEndpoint.trim() : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
        napCatSignature: typeof src.napCatSignature === 'string' ? src.napCatSignature.trim() : DEFAULT_LOGIN_SETTINGS.napCatSignature,
    };
}

function getLoginSettings(): LoginSettings {
    return normalizeLoginSettings(globalConfig.loginSettings);
}

function setLoginSettings(cfg: Partial<LoginSettings> | undefined): LoginSettings {
    const next = normalizeLoginSettings({ ...getLoginSettings(), ...(cfg || {}) });
    if (next.qqQrLogin && (!next.napCatEndpoint || !next.napCatSignature)) {
        throw new Error('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名');
    }
    saveGlobalConfig({ loginSettings: next });
    return getLoginSettings();
}

function setOfflineReminder(cfg: Partial<OfflineReminder> | undefined, username?: unknown): OfflineReminder {
    const name = String(username || '').trim();
    if (!name) {
        // 未指定用户：写入全局配置（兼容旧行为/兜底）
        const current = normalizeOfflineReminder(globalConfig.offlineReminder);
        const next = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
        saveGlobalConfig({ offlineReminder: next });
        return getOfflineReminder();
    }
    // 指定用户：写入该用户自己的配置，互不影响
    if (!globalConfig.userOfflineReminders) {
        globalConfig.userOfflineReminders = {};
    }
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders[name] || {});
    const next = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    globalConfig.userOfflineReminders[name] = next;
    saveGlobalConfig({ userOfflineReminders: { ...globalConfig.userOfflineReminders } });
    return getOfflineReminder(name);
}

function getUsersSeeAllAccounts(): boolean {
    return globalConfig.usersSeeAllAccounts === true;
}

function setUsersSeeAllAccounts(enabled: unknown): boolean {
    const next = enabled === true;
    saveGlobalConfig({ usersSeeAllAccounts: next });
    return getUsersSeeAllAccounts();
}

function getCoinRankVisibility(): 'all' | 'super_admin' {
    return globalConfig.coinRankVisibility === 'super_admin' ? 'super_admin' : 'all';
}

function setCoinRankVisibility(value: unknown): 'all' | 'super_admin' {
    const next = value === 'super_admin' ? 'super_admin' : 'all';
    saveGlobalConfig({ coinRankVisibility: next });
    return getCoinRankVisibility();
}

function getSystemConfig(): SystemConfig | null {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config: Partial<SystemConfig> | undefined): SystemConfig | null {
    if (!config || typeof config !== 'object') return null;
    const DEFAULT_DEVICE_INFO = {
        os: 'Windows',
        clientVersion: DEFAULT_CLIENT_VERSION,
        sysSoftware: 'Windows',
        network: 'wifi',
        memory: '16384',
        deviceId: 'DESKTOP-PC<WPC>',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
    };
    const current = globalConfig.systemConfig;
    const srcDevice = {
        ...(current?.deviceInfo || {}),
        ...((config.deviceInfo && typeof config.deviceInfo === 'object') ? config.deviceInfo : {}),
    };
    const topVersion = String(config.clientVersion || '').trim();
    const deviceVersion = String(config.deviceInfo?.clientVersion || '').trim();
    const requestedVersion = deviceVersion || topVersion || current?.clientVersion;
    const clientVersion = requestedVersion || DEFAULT_DEVICE_INFO.clientVersion;
    const currentVersion = String(globalConfig.systemConfig?.clientVersion || DEFAULT_DEVICE_INFO.clientVersion).trim();
    const currentUpdatedAt = Number(globalConfig.systemConfig?.clientVersionUpdatedAt);
    const clientVersionUpdatedAt = resolveClientVersionUpdatedAt(
        clientVersion,
        currentVersion,
        currentUpdatedAt,
        config.clientVersionUpdatedAt,
    );
    // Older API clients may omit the new field; never copy the QQ version into it.
    const currentWxVersion = globalConfig.systemConfig?.wxClientVersion || DEFAULT_WX_CLIENT_VERSION;
    const wxClientVersion = config.wxClientVersion === undefined
        ? currentWxVersion : (String(config.wxClientVersion || '').trim() || DEFAULT_WX_CLIENT_VERSION);
    const wxClientVersionUpdatedAt = resolveClientVersionUpdatedAt(
        wxClientVersion, currentWxVersion, globalConfig.systemConfig?.wxClientVersionUpdatedAt,
        config.wxClientVersionUpdatedAt, Date.now(), 'wx',
    );
    const deviceInfo = {
        os: String((srcDevice as any).os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion,
        sysSoftware: String((srcDevice as any).sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String((srcDevice as any).network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String((srcDevice as any).memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String((srcDevice as any).deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String((srcDevice as any).userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
    const next: SystemConfig = {
        serverUrl: String(config.serverUrl ?? current?.serverUrl ?? '').trim(),
        clientVersion: deviceInfo.clientVersion,
        clientVersionUpdatedAt,
        wxClientVersion,
        wxClientVersionUpdatedAt,
        platform: String(config.platform || current?.platform || 'qq').trim(),
        os: deviceInfo.os,
        timeZone: normalizeTimeZone(config.timeZone || current?.timeZone || DEFAULT_TIME_ZONE),
        deviceInfo,
    };
    saveGlobalConfig({ systemConfig: next });
    return { ...globalConfig.systemConfig };
}

// Initialize on load
const { loadGlobalConfig } = sharedState;
loadGlobalConfig();
// Apply offlineReminder normalization after load
globalConfig.offlineReminder = normalizeOfflineReminder(globalConfig.offlineReminder);
globalConfig.loginSettings = normalizeLoginSettings(globalConfig.loginSettings);
if (sharedState.systemConfigMigrated && !process.env.FARM_ACCOUNT_ID) {
    saveGlobalConfig();
    sharedState.systemConfigMigrated = false;
}

module.exports = {
    saveGlobalConfig,
    getUI,
    setUITheme,
    getLoginSettings,
    setLoginSettings,
    getOfflineReminder,
    setOfflineReminder,
    getUsersSeeAllAccounts,
    setUsersSeeAllAccounts,
    getCoinRankVisibility,
    setCoinRankVisibility,
    getSystemConfig,
    setSystemConfig,
};
