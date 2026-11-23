export {};
const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { normalizeLogSpace } = require('../utils/utils');

interface DataProviderOptions {
    workers: Record<string, any>;
    /** 按空间拆分的运行日志池：farm=全部非牧场日志，ranch=牧场日志 */
    logPools: { farm: any[]; ranch: any[] };
    accountLogs: any[];
    store: any;
    getAccounts: () => any;
    callWorkerApi: (accountId: string, method: string, ...args: any[]) => Promise<any>;
    buildDefaultStatus: (accountId: string) => any;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    filterLogs: (list: any[], filters?: any) => any[];
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    nextConfigRevision: () => number;
    broadcastConfigToWorkers: (accountId?: string) => void;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    broadcastGameConfigReload?: () => void;
    startWorker: (account: any) => boolean;
    stopWorker: (accountId: string) => void;
    restartWorker: (account: any) => void;
    // 微信定时刷新重登（自 qq-farm-bot 移植）
    scheduleAutoCodeRefresh?: (accountId: string) => void;
    stopAutoCodeRefresh?: (accountId: string) => void;
    refreshAccountCode?: (accountId: string, reason?: string) => Promise<boolean>;
    /** 微信授权是否已被明确撤销（需要重新扫码才能恢复） */
    needsWxRescan?: (accountId: string) => boolean;
}

/**
 * 合并两个空间的日志池并按 ts 升序。
 * 两个池各自按写入顺序（即时间序）排列，直接拼接后并非全局时间序，
 * 不排序的话 slice(-max) 会截到 ranch 池的尾巴而非全局最新。
 */
function mergeLogPools(pools: { farm: any[]; ranch: any[] }): any[] {
    return [...(pools.farm || []), ...(pools.ranch || [])]
        .sort((a, b) => (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0));
}

function createDataProvider(options: DataProviderOptions) {
    const {
        workers,
        logPools,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload: broadcastGameConfigReloadOpt,
        startWorker,
        stopWorker,
        restartWorker,
        scheduleAutoCodeRefresh,
        stopAutoCodeRefresh,
        refreshAccountCode,
        needsWxRescan,
    } = options;

    function getStoredAccountsList(): any[] {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    function resolveAccountRefId(accountRef: string): string {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) return '';
        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);
        return resolved || raw;
    }

    function findAccountByAnyRef(accountRef: string): any {
        return findAccountByRef(getStoredAccountsList(), accountRef);
    }

    return {
        resolveAccountId: (accountRef: string) => resolveAccountRefId(accountRef),

        getStatus: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return buildDefaultStatus('');
            const w = workers[accountId];
            if (!w || !w.status) return buildDefaultStatus(accountId);
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError: w.wsError || null,
            };
        },

        getLogs: (accountRef: string, optionsOrLimit?: any) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            // space：ranch/farm 精确取池；未指定或非法 → 两池合并（等价旧的全量语义，向后兼容）
            const space = normalizeLogSpace(opts.space);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            const source = space ? (logPools[space] || []) : mergeLogPools(logPools);
            if (!rawRef || rawRef === 'all') {
                return filterLogs(source, opts).slice(-max);
            }
            if (!accountId) return [];
            const accId = String(accountId || '');
            return filterLogs(source.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },

        getAccountLogs: (limit: number) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => addAccountLog(action, msg, accountId, accountName, extra),

        clearLogs: (accountRef: string, optionsOrSpace?: any) => {
            // 可选 space 只清单个空间；不传则清该账号在两个空间的全部运行日志
            // 入参支持两种形态：字符串 'ranch' / 'farm'，或 options 对象 { space }
            const space = normalizeLogSpace(
                (optionsOrSpace && typeof optionsOrSpace === 'object')
                    ? optionsOrSpace.space
                    : optionsOrSpace,
            );
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            const targets = space ? [logPools[space] || []] : Object.values(logPools);

            if (!rawRef || rawRef === 'all') {
                for (const pool of targets) pool.length = 0;
                return { cleared: 'all' };
            }

            if (!accountId) return { cleared: 0 };

            const accId = String(accountId || '');
            let cleared = 0;
            for (const pool of targets) {
                for (let i = pool.length - 1; i >= 0; i--) {
                    if (String(pool[i].accountId || '') === accId) {
                        pool.splice(i, 1);
                        cleared++;
                    }
                }
            }
            return { cleared, accountId };
        },

        getLands: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands', true),
        getIllustratedSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustratedSnapshot'),
        getCollectionsSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCollectionsSnapshot'),
        operateCollections: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateCollections', action, input),
        getRanchState: (accountRef: string, view: string, shopId?: number, hostGid?: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getRanchState', view, shopId, hostGid),
        clearRanchIllustratedNew: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'clearRanchIllustratedNew'),
        prepareRanchAction: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'prepareRanchAction', action, input),
        operateRanch: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateRanch', action, input),
        claimIllustratedRewards: (accountRef: string, type: number) => callWorkerApi(resolveAccountRefId(accountRef), 'claimIllustratedRewards', type),
        clearIllustratedNew: (accountRef: string, fruitIds: number[]) => callWorkerApi(resolveAccountRefId(accountRef), 'clearIllustratedNew', fruitIds),
        getSolarCalendar: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getSolarCalendar'),
        operateSolarCalendar: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateSolarCalendar', action, input),
        getFriends: (accountRef: string, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync, true),
        getFriendsCache: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendsCache'),
        clearFriendsCache: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef: string, gid: number) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid, true),
        getFriendInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getFriendInteractionItems', true)
        ),
        useFriendInteractionItemBatch: (accountRef: string, gid: unknown, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useFriendInteractionItemBatch', gid, itemId, landIds, true)
        ),
        useFriendFarmInteractionItem: (accountRef: string, gid: unknown, itemId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useFriendFarmInteractionItem', gid, itemId, true)
        ),
        getSelfInteractionItems: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getSelfInteractionItems', true)
        ),
        useSelfInteractionItemBatch: (accountRef: string, itemId: unknown, landIds: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useSelfInteractionItemBatch', itemId, landIds, true)
        ),
        doFriendOp: (accountRef: string, gid: number, opType: string) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType, true),
        delFriend: (accountRef: string, gid: number) => callWorkerApi(resolveAccountRefId(accountRef), 'delFriend', gid),
        getBag: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getBagSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),
        getDiamondBalance: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getDiamondBalance'),
        useItem: (accountRef: string, itemId: number, count: number, uid = 0) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count, uid),
        sellItems: (accountRef: string, items: any[]) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),
        setItemsLocked: (accountRef: string, itemUids: unknown, locked: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'setItemsLocked', itemUids, locked)
        ),
        getDogSkillGiftStatus: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getDogSkillGiftStatus')
        ),
        claimDogSkillGifts: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'claimDogSkillGifts')
        ),
        getPetInfo: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getPetInfo')
        ),
        activateDog: (accountRef: string, dogId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'activateDog', dogId)
        ),
        deployDog: (accountRef: string, dogId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'deployDog', dogId)
        ),
        withdrawDog: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'withdrawDog')
        ),
        useDogFood: (accountRef: string, itemId: unknown, count: unknown = 1, uid: unknown = 0) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useDogFood', itemId, count, uid)
        ),
        getPetProtectLogs: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getPetProtectLogs')
        ),
        getDailyGifts: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview', true),
        getActivityDirectorySnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityDirectorySnapshot'),
        getRanchActivityDirectorySnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getRanchActivityDirectorySnapshot'),
        getActivityCenterSnapshot: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityCenterSnapshot'),
        getCurrentSeasonEvent: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSeasonEvent'),
        getCurrentStellarActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStellarActivity'),
        getCurrentStarSandShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStarSandShop'),
        getCurrentSolarTerms: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSolarTerms'),
        getCurrentQixiActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQixiActivity'),
        getCurrentCharityRedFlowerActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentCharityRedFlowerActivity'),
        getPetDiary: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiary'),
        operatePetDiary: (accountRef: string, action: unknown, params: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'operatePetDiary', action, params),
        getPetDiaryRecords: (accountRef: string, kind: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiaryRecords', kind),
        getPetDiaryFriend: (accountRef: string, gid: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'getPetDiaryFriend', gid),
        claimCharityRedFlowerSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerSeeds'),
        donateCharityRedFlowerLove: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'donateCharityRedFlowerLove'),
        claimCharityRedFlowerDailyGift: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerDailyGift'),
        claimCharityRedFlowerProgressReward: (accountRef: string, target: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'claimCharityRedFlowerProgressReward', target),
        getCurrentWeatherActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentWeatherActivity'),
        buyWeatherBottle: (accountRef: string, count: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'buyWeatherBottle', count),
        collectWeatherBottle: (accountRef: string, targetGid: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'collectWeatherBottle', targetGid),
        lightWeatherResearch: (accountRef: string, nodeId: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'lightWeatherResearch', nodeId),
        summonWeatherRain: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'summonWeatherRain'),
        claimBattlePassRewards: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimBattlePassRewards'),
        exchangeStarSandGoods: (accountRef: string, goodsId: unknown, count: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'exchangeStarSandGoods', goodsId, count)
        ),
        lightConstellation: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'lightConstellation'),
        claimSolarTerm: (accountRef: string, termId: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimSolarTerm', termId),
        getCurrentQingMeiActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQingMeiActivity'),
        claimQingMeiDailySeed: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQingMeiDailySeed'),
        startQingMeiBrew: (accountRef: string, ingredients: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'startQingMeiBrew', ingredients),
        continueQingMeiBrew: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'continueQingMeiBrew'),
        settleQingMeiBrew: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'settleQingMeiBrew'),
        claimQixiBridgeRewards: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQixiBridgeRewards'),
        giftQixiSachet: (accountRef: string, friendGid: unknown, messageTextId: unknown = 15) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'giftQixiSachet', friendGid, messageTextId)
        ),
        exchangeWeatherCollectorBottle: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'exchangeWeatherCollectorBottle')
        ),
        getWeatherFriends: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getWeatherFriends')
        ),
        scanWeatherFriends: (accountRef: string, friendGids: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'scanWeatherFriends', friendGids)
        ),
        useWeatherCollectorBottle: (accountRef: string, friendGid: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCollectorBottle', friendGid)
        ),
        useWeatherSummonBottle: (accountRef: string) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherSummonBottle')
        ),
        useWeatherFrogBottle: (accountRef: string, friendGid: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherFrogBottle', friendGid)
        ),
        useWeatherCloudBottle: (accountRef: string, friendGid: unknown, landId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'useWeatherCloudBottle', friendGid, landId)
        ),
        advanceWeatherResearch: (accountRef: string, nodeId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'advanceWeatherResearch', nodeId)
        ),
        getMugeActivity: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getMugeActivity'),
        operateMugeActivity: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateMugeActivity', action, input),
        getMilkTeaActivity: (accountRef: string, page: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'getMilkTeaActivity', page, input),
        operateMilkTeaActivity: (accountRef: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateMilkTeaActivity', action, input),
        getShareRewardActivity: (accountRef: string, activityId: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getShareRewardActivity', activityId),
        operateShareRewardActivity: (accountRef: string, activityId: string, action: string, input: any) => callWorkerApi(resolveAccountRefId(accountRef), 'operateShareRewardActivity', activityId, action, input),
        getAutumnActivity: (accountRef: string, key: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getAutumnActivity', key),
        operateAutumnActivity: (accountRef: string, key: string, action: string, input: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'operateAutumnActivity', key, action, input),
        getPropsShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getPropsShop'),
        purchaseProps: (accountRef: string, goodsId: unknown, count: unknown, expectedOffer: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseProps', goodsId, count, expectedOffer)
        ),
        getMallCatalog: (accountRef: string, slotType: unknown, subSlotType: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'getMallCatalog', slotType, subSlotType)
        ),
        purchaseMallProduct: (accountRef: string, goodsId: unknown, count: unknown, slotType: unknown, expectedPrice?: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMallProduct', goodsId, count, slotType, expectedPrice)
        ),
        getMysteryShop: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getMysteryShop'),
        purchaseMysteryOffer: (accountRef: string, npcId: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'purchaseMysteryOffer', npcId)
        ),
        getSeeds: (accountRef: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds', true),
        purchaseSeed: (accountRef: string, goodsId: unknown, count: unknown) => callWorkerApi(resolveAccountRefId(accountRef), 'purchaseSeed', goodsId, count),

        setAutomation: async (accountRef: string, key: string, value: any) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },

        doFarmOp: (accountRef: string, opType: string, targetLandId: unknown = null) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType, targetLandId, true)
        ),
        fertilizeOwnLand: (accountRef: string, landId: unknown, fertilizerType: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'fertilizeOwnLand', landId, fertilizerType)
        ),
        fertilizeAllOwnLands: (accountRef: string, fertilizerType: unknown, landIds?: unknown) => (
            callWorkerApi(resolveAccountRefId(accountRef), 'fertilizeAllOwnLands', fertilizerType, landIds)
        ),

        doAnalytics: (accountRef: string, sortBy: string) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef: string, type: string, count: number) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count, true),
        checkAndBuyFertilizer: (accountRef: string, options: any) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options, true),
        saveSettings: async (accountRef: string, payload: any) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const snapshot: Record<string, any> = {};
            const copyIfPresent = (sourceKey: string, targetKey: string = sourceKey): void => {
                if (Object.hasOwn(body, sourceKey)) {
                    snapshot[targetKey] = body[sourceKey];
                }
            };

            copyIfPresent('plantingStrategy');
            if (!Object.hasOwn(snapshot, 'plantingStrategy')) copyIfPresent('strategy', 'plantingStrategy');
            copyIfPresent('preferredSeedId');
            if (!Object.hasOwn(snapshot, 'preferredSeedId')) copyIfPresent('seedId', 'preferredSeedId');
            for (const key of [
                'automation',
                'intervals',
                'friendQuietHours',
                'stealDelaySeconds',
                'plantOrderRandom',
                'plantDelaySeconds',
                'fertilizerBuyOrganicCount',
                'fertilizerBuyOrganicThresholdHours',
                'fertilizerBuyNormalCount',
                'fertilizerBuyNormalThresholdHours',
                'fertilizerBuyCheckIntervalMinutes',
                'emailClaimHour',
                'bagSeedPriority',
                'bagSeedMultiLandReservationEnabled',
                'bagSeedLandTypes',
                'bagSeedFallbackStrategy',
                'autoAcceptFriendMinLevel',
                'autoAcceptRequireOwnLevel',
                'autoAcceptHarvestStealEnabled',
                'autoAcceptHarvestStealHarvest',
                'autoAcceptHarvestStealSteal',
            ]) {
                copyIfPresent(key);
            }

            // One apply performs the only persistence for this save request.
            store.applyConfigSnapshot(snapshot, { accountId });
            const rev = nextConfigRevision();
            const config = buildConfigSnapshotForAccount(accountId);
            const { ui: _ui, ...savedConfig } = store.getConfigSnapshot(accountId);
            const result: Record<string, any> = {
                ...savedConfig,
                strategy: savedConfig.plantingStrategy,
                preferredSeed: savedConfig.preferredSeedId,
                saved: true,
                configRevision: rev,
            };

            const targetWorker = workers[accountId];
            if (!targetWorker || targetWorker.stopping || targetWorker.terminalHandled) {
                return {
                    ...result,
                    status: 'stopped',
                    stopped: true,
                    confirmed: false,
                    appliedRevision: null,
                };
            }

            try {
                const ack = await callWorkerApi(accountId, 'applyRuntimeConfigSnapshot', config);
                const appliedRevision = Number(ack && ack.appliedRevision);
                if (!Number.isFinite(appliedRevision) || appliedRevision < rev) {
                    const error: any = new Error(`Worker applied revision ${appliedRevision || 0}, expected at least ${rev}`);
                    error.code = 'CONFIG_ACK_REVISION_MISMATCH';
                    throw error;
                }
                return {
                    ...result,
                    status: 'confirmed',
                    stopped: false,
                    confirmed: true,
                    appliedRevision,
                };
            } catch (e: any) {
                const message = String(e?.message || e || 'Worker configuration ACK failed');
                const code = e?.code || (message === 'API Timeout' ? 'CONFIG_ACK_TIMEOUT' : 'CONFIG_ACK_FAILED');
                return {
                    ...result,
                    status: 'unconfirmed',
                    stopped: false,
                    confirmed: false,
                    unconfirmed: true,
                    appliedRevision: null,
                    confirmationError: {
                        code: String(code),
                        message,
                    },
                };
            }
        },

        setUITheme: async (theme: string) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },

        broadcastConfig: (accountId: string) => {
            broadcastConfigToWorkers(accountId);
        },

        broadcastGameConfigReload: () => {
            if (typeof broadcastGameConfigReloadOpt === 'function') broadcastGameConfigReloadOpt();
        },

        setRuntimeAccountName: (accountRef: string, accountName: string) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },

        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach((a: any) => {
                const worker = workers[a.id];
                a.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    a.nick = worker.status.status.name;
                }
                if (worker && worker.status && worker.status.status && worker.status.status.avatarUrl) {
                    a.avatar = worker.status.status.avatarUrl;
                }
            });
            return data;
        },

        startAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            startWorker(acc);
            return true;
        },

        /**
         * 手动点“启动”时使用：微信扫码号先用可再生凭证换一个新 Code 再拉起。
         *
         * 账号里存的 Code 很可能已经过期，直接 startWorker 会立刻 WS 400 →
         * 触发自动重登（用户看到“重新连接”）→ 约 10 秒后才连上，体验像“第一次点启动不上”。
         * 这里与应用启动流程 startAllAccounts 保持一致：先刷新 Code，
         * refreshAccountCode 成功时内部已通过 restartWorker 拉起 worker；失败则回退旧 Code 直接启动。
         * QQ 号没有可再生凭证，直接按原逻辑启动。
         */
        startAccountWithFreshCode: async (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (acc.platform === 'wx' && acc.loginBuffer && typeof refreshAccountCode === 'function') {
                try {
                    const refreshed = await refreshAccountCode(String(acc.id), 'manual_start');
                    if (refreshed) return true;
                } catch {
                    // 刷新失败回退到旧 Code 直接启动
                }
            }
            return startWorker(acc);
        },

        stopAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) stopWorker(accountId);
            return true;
        },

        restartAccount: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            restartWorker(acc);
            return true;
        },

        isAccountRunning: (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },

        getSchedulerStatus: async (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const runtime = getSchedulerRegistrySnapshot();
            let worker = null;
            let workerError = '';

            if (!accountId) {
                return { accountId: '', runtime, worker, workerError };
            }

            if (!workers[accountId]) {
                return { accountId, runtime, worker, workerError: '账号未运行' };
            }

            try {
                worker = await callWorkerApi(accountId, 'getSchedulers');
            } catch (e: any) {
                workerError = (e && e.message) ? e.message : String(e || 'unknown');
            }
            return { accountId, runtime, worker, workerError };
        },

        // —— 微信定时刷新重登（自 qq-farm-bot 移植）：路由层透传 ——
        scheduleAutoCodeRefresh: (accountId: string) => {
            if (typeof scheduleAutoCodeRefresh === 'function') scheduleAutoCodeRefresh(String(accountId || ''));
        },
        stopAutoCodeRefresh: (accountId: string) => {
            if (typeof stopAutoCodeRefresh === 'function') stopAutoCodeRefresh(String(accountId || ''));
        },
        refreshAccountCode: (accountId: string, reason?: string) => {
            if (typeof refreshAccountCode !== 'function') return Promise.resolve(false);
            return Promise.resolve(refreshAccountCode(String(accountId || ''), reason || 'manual'));
        },

        /**
         * 一键重连：用账号自带的可再生凭证换新 Code 并重启 Worker。
         *
         * 与 startAccountWithFreshCode 的区别：不回退到旧 Code 直接启动——
         * 旧 Code 几乎必然已过期，直接启动只会得到 WS 400 然后再绕一圈自动重登。
         * 这里把失败原因结构化返回，让前端能区分「网络抖动，稍后重试」与
         * 「授权已被撤销，必须重新扫码」，避免用户对着同一个坏账号反复点。
         */
        reconnectAccount: async (accountRef: string) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc)
                return { ok: false as const, reason: 'not_found' as const, message: '账号不存在' };

            const platform = String(acc.platform || '');
            if (platform !== 'wx')
                return { ok: false as const, reason: 'unsupported_platform' as const, message: '仅微信账号支持一键重连' };

            const hasCredential = !!String(acc.loginBuffer || '').trim();
            if (!hasCredential)
                return { ok: false as const, reason: 'no_credential' as const, message: '该账号没有登录凭据，请重新扫码' };

            // 已明确失效的授权必须重新扫码：继续换 Code 只会反复失败
            if (typeof needsWxRescan === 'function' && needsWxRescan(String(acc.id))) {
                return { ok: false as const, reason: 'need_rescan' as const, message: '微信授权已失效，请重新扫码登录' };
            }

            if (typeof refreshAccountCode !== 'function')
                return { ok: false as const, reason: 'unsupported' as const, message: '当前运行模式不支持一键重连' };

            let refreshed = false;
            try {
                refreshed = await refreshAccountCode(String(acc.id), 'manual_reconnect');
            }
            catch (error: any) {
                if (typeof needsWxRescan === 'function' && needsWxRescan(String(acc.id))) {
                    return { ok: false as const, reason: 'need_rescan' as const, message: '微信授权已失效，请重新扫码登录' };
                }
                return {
                    ok: false as const,
                    reason: 'refresh_failed' as const,
                    message: error?.message ? String(error.message) : '重连失败，请稍后重试',
                };
            }

            if (!refreshed) {
                // 连续 -109 升级或本次明确失效都可能发生在刷新过程中；返回结构化
                // need_rescan，避免面板继续显示误导性的“请检查网络”。
                if (typeof needsWxRescan === 'function' && needsWxRescan(String(acc.id))) {
                    return { ok: false as const, reason: 'need_rescan' as const, message: '微信授权已失效，请重新扫码登录' };
                }
                return {
                    ok: false as const,
                    reason: 'refresh_failed' as const,
                    message: '重连失败：请检查网络，或重新扫码登录',
                };
            }
            return { ok: true as const, reason: 'reconnected' as const, message: '重连成功' };
        },
    };
}

module.exports = {
    createDataProvider,
};
