export {};

/**
 * Classifies outgoing RPCs so session-host and SendContext can distinguish read-only
 * state/precheck queries from potentially state-mutating write RPCs.
 */
const READ_ONLY_METHODS = new Set([
    'Heartbeat',
    'AntiData',
    'Login',
    'PlayerLogin',
    'PlayerSceneLogin',
    'AllLands',
    'AllCells',
    'Bag',
    'List',
    'SyncAll',
    'ShopInfo',
    'ShopProfiles',
    'RotationShopInfo',
    'TaskInfo',
    'InteractRecords',
    'SkinsOwned',
    'SkinsEquipped',
    'AvatarFramesOwned',
    'CareerInfoGet',
    'MugeList',
]);

const READ_ONLY_PREFIX = /^(?:Get|BatchGet|Check|Query|Read|Peek|Fetch)/;

function isWriteRpc(_serviceName: string, methodName: string): boolean {
    const method = String(methodName || '').trim();
    if (!method) return true;
    if (READ_ONLY_METHODS.has(method) || READ_ONLY_PREFIX.test(method)) {
        return false;
    }
    return true;
}

module.exports = {
    isWriteRpc,
    READ_ONLY_METHODS,
};
