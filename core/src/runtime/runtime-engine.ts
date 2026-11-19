export {};
const { fork } = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { sendPushooMessage, sendSmtpEmail } = require('../services/push');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createAutoCodeRefreshService } = require('./auto-code-refresh');
const wxCredentialGuard = require('../services/wx-credential-guard');
const wxCredentials = require('../services/wx-credentials');
const kickGuard = require('../services/kick-guard');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');

const OPERATION_KEYS = ['harvest', 'water', 'weed', 'bug', 'farming', 'fertilize', 'plant', 'steal', 'helpFarming', 'helpWater', 'goldenBugClear', 'goldenBugPut', 'helpWeed', 'helpBug', 'taskClaim', 'sell', 'upgrade', 'levelUp', 'tongQiGift'];

interface RuntimeEngineOptions {
    processRef?: any;
    mainEntryPath?: string;
    workerScriptPath?: string;
    runtimeMode?: string;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onLog?: (entry: any, accountId?: string, accountName?: string) => void;
    onAccountLog?: (entry: any) => void;
    startAdminServer?: (dataProvider: any) => void;
}

function createRuntimeEngine(options: RuntimeEngineOptions = {}) {
    const processRef = options.processRef || process;
    // Detect if running from source (tsx) or compiled (node)
    const isRunningFromSource = __dirname.includes(`${path.sep}src${path.sep}`);
    const fileExt = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, `../../client${fileExt}`);
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, `../core/worker${fileExt}`);
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const {
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    } = runtimeState;

    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        sendSmtpEmail,
        log,
    });

    const {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
    } = reloginReminder;

    const onWxCredentialDefinitivelyInvalid = async (payload: any) => {
        const accountId = String((payload && payload.accountId) || '');
        const account = store.getAccounts().accounts.find((a: any) => String(a.id) === accountId);
        const snapshot = {
            accountId,
            owner: String((payload && payload.owner) || ''),
            wxid: String((payload && payload.wxid) || ''),
        };
        const changed = wxCredentialGuard.noteCredentialInvalid(snapshot, async () => {
            addAccountLog('wx_login_reminder', '微信凭据已明确失效，需要重新扫码授权', accountId, account && account.name || '', { reason: 'definitive' });
            await triggerOfflineReminder({
                accountId,
                accountName: account && account.name || '',
                reason: 'wx_credential_invalid',
                offlineMs: 0,
            });
        });
        if (!changed) return;
    };

    // 微信定时刷新服务：worker-manager 里先注入转发桩，服务实例创建后再回填
    // （避免 workerManager 与 autoCodeRefresh 的循环依赖：刷新成功需要 restartWorker）
    const autoReloginHooks: {
        scheduleAutoRelogin?: (accountId: string, reason?: string) => boolean;
        refreshAccountCode?: (accountId: string, reason?: string) => Promise<boolean>;
    } = {};

    const { startWorker, stopWorker, restartWorker, callWorkerApi } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        scheduleAutoRelogin: (accountId: string, reason?: string) => autoReloginHooks.scheduleAutoRelogin?.(accountId, reason) || false,
        refreshAccountCode: (accountId: string, reason?: string) => autoReloginHooks.refreshAccountCode?.(accountId, reason) || Promise.resolve(false),
        shouldStopAutoRelogin: (accountId: string, reason: unknown) => kickGuard.shouldStopAutoRelogin(accountId, reason),
        scheduleAccountRefresh: (accountId: string) => autoCodeRefresh.scheduleAccount(accountId),
        stopAccountRefresh: (accountId: string) => autoCodeRefresh.stopAccount(accountId),
        onStatusSync: (accountId: string, status: any, accountName?: string) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry: any, accountId: string, accountName?: string) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        },
    });

    const autoCodeRefresh = createAutoCodeRefreshService({
        store,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => ({ restartWorker }),
        log,
        addAccountLog,
        needsWxRescan: wxCredentialGuard.needsRescan,
        onWxCredentialDefinitivelyInvalid,
        keepWxCredentialAlive: wxCredentials.keepWxCredentialAlive,
    });
    autoReloginHooks.scheduleAutoRelogin = autoCodeRefresh.scheduleRelogin;
    autoReloginHooks.refreshAccountCode = autoCodeRefresh.refreshAccountCode;
    const dataProvider = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        scheduleAutoCodeRefresh: autoCodeRefresh.scheduleAccount,
        stopAutoCodeRefresh: autoCodeRefresh.stopAccount,
        refreshAccountCode: autoCodeRefresh.refreshAccountCode,
    });

    runtimeEvents.on('log', (entry: any) => {
        if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry: any) => {
        if (onAccountLog) onAccountLog(entry);
    });

    function broadcastConfigToWorkers(targetAccountId = ''): void {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId) continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                (worker as any).process.send({ type: 'config_sync', config: snapshot });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function broadcastGameConfigReload(): void {
        for (const worker of Object.values(workers)) {
            try {
                (worker as any).process.send({ type: 'reload_config' });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    async function startAllAccounts(): Promise<void> {
        const accounts = (store.getAccounts().accounts || []);
        if (accounts.length > 0) {
            log('系统', `发现 ${accounts.length} 个账号，正在启动...`);
            for (const acc of accounts) {
                // 为移植前已扫码保存凭证的微信账号执行一次默认策略迁移：开启断线自动恢复（在线不再定时换码）
                if (acc.platform === 'wx' && acc.loginBuffer && acc.wxDefaultsApplied !== true) {
                    const currentRefresh = store.getAutoCodeRefresh(acc.id);
                    store.setAutoCodeRefresh(acc.id, {
                        enabled: true,
                        intervalMinutes: currentRefresh.intervalMinutes || 60,
                    });
                    store.addOrUpdateAccount({ id: acc.id, wxDefaultsApplied: true });
                    acc.wxDefaultsApplied = true;
                    log('系统', `已为微信扫码账号 ${acc.name} 默认开启断线自动恢复`, {
                        accountId: String(acc.id), accountName: acc.name,
                    });
                }
                if (acc.platform === 'wx' && acc.loginBuffer) {
                    // 微信扫码号：启动时先换新 Code。明确失效时不再用旧 Code
                    // 启动；临时失败则交给断线恢复排程，不再每小时主动重启。
                    const refreshed = await autoCodeRefresh.refreshAccountCode(acc.id, 'startup');
                    if (!refreshed && !autoCodeRefresh.isCredentialBlocked(acc.id)) {
                        const scheduled = autoCodeRefresh.scheduleRelogin(acc.id, 'startup');
                        if (!scheduled) startWorker(acc);
                    }
                } else {
                    startWorker(acc);
                }
            }
        } else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    async function start(options: { startAdminServer?: boolean; autoStartAccounts?: boolean } = {}): Promise<void> {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;

        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }

        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (shouldAutoStartAccounts) {
            await startAllAccounts();
        }
        // 按最新账号列表重建定时刷新/保活调度（幂等，QQ 号静默跳过）
        autoCodeRefresh.rescheduleAll();
    }

    function stopAllAccounts(): void {
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog,
    };
}

module.exports = {
    createRuntimeEngine,
};
