import config from '../activity-data/maple-market-20261125.json';

export {};

const { getUserState, sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, toNum } = require('../utils/utils');
const { markWriteStart } = require('../utils/request-context');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { getBag, getBagItems, isItemLocked } = require('./warehouse');
const { invalidateActivityListReply } = require('./activity-list');
const { forCurrentAccount } = require('./resource-reservations');

const SERVICE = 'gamepb.activitypb.ActivityService';
const { groupId, activityId, seedItemId, cropItemId, coinItemId } = config;
const goodsById = new Map(config.goods.map(goods => [goods.id, goods]));
const operations = {
    claimSeed: { cmd: 91, field: 'maple_market_claim_seed', hasReqBody: true },
    getShop: { cmd: 92, field: 'maple_market_get_shop', hasReqBody: true },
    sell: { cmd: 93, field: 'maple_market_sell', hasReqBody: true },
    getPurchaseLog: { cmd: 95, field: 'maple_market_get_purchase_log', hasReqBody: true },
    exchange: { cmd: 96, field: 'maple_market_exchange', hasReqBody: true },
    getGoods: { cmd: 97, field: 'maple_market_get_goods_list', hasReqBody: true },
    claimCommission: { cmd: 99, field: 'maple_market_claim_commission', hasReqBody: false },
} as const;

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function parseRules(extra: unknown): string[] {
    if (!extra || !(extra instanceof Uint8Array) || !extra.length) return [];
    try {
        const parsed = JSON.parse(Buffer.from(extra).toString('utf8'));
        if (!Array.isArray(parsed?.tips?.txt)) return [];
        return parsed.tips.txt
            .map((line: unknown) => String(line).replace(/<[^>]+>/g, '').trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function getMarketProgress() {
    const request = types.GetGroupRequest.encode({ group_id: groupId }).finish();
    const response = await sendMsgAsync(SERVICE, 'GetGroup', request);
    const { group } = types.GetGroupReply.decode(response.body);
    const node = group?.children.find((child: any) => String(child.activity?.activity_id) === activityId);
    if (String(group?.activity?.activity_id) !== groupId || !node?.maple_market) {
        fail('MAPLE_MARKET_UNAVAILABLE', '以薯换福活动数据暂不可用');
    }

    const head = node.activity;
    const market = node.maple_market;
    const now = getServerTimeSec();
    const start = toNum(head.begin_time);
    const end = toNum(head.end_time);
    const settle = toNum(head.settle_start_time);
    const phase = now < start ? 'upcoming'
        : now > end ? 'ended'
            : settle > 0 && now >= settle ? 'settlement'
                : toNum(head.field_20) === 1 ? 'active' : 'unavailable';
    const seedClaimed = market.daily_state?.seed_claimed === true;
    // 服务端待领标记是每日资格。活动仍在目录里时也可能已进入兑换期。
    const canClaimSeed = phase === 'active' && !seedClaimed && market.red_dots?.seed_unclaimed === true;
    const pendingCommissionCoin = toNum(market.pending_commission_coin);
    const pendingCommissionCount = toNum(market.pending_commission_count);
    const canClaimCommission = (phase === 'active' || phase === 'settlement') && pendingCommissionCoin > 0;
    return {
        activityId: groupId, serverTime: now * 1000, startTime: start * 1000, endTime: end * 1000,
        phase, seedClaimed, canClaimSeed, seedItemId, cropItemId, coinItemId,
        shared: market.daily_state?.shared === true,
        coinBalance: toNum(market.activity_coin),
        pendingCommissionCoin,
        pendingCommissionCount,
        canClaimCommission,
        purchaseLogUnread: market.red_dots?.purchase_log_unread === true,
        rules: parseRules(head.extra),
    };
}

async function operate(action: keyof typeof operations, params: Record<string, unknown> = {}) {
    const { cmd, field, hasReqBody } = operations[action];
    const payload = hasReqBody ? { id: activityId, cmd, [field]: params } : { id: activityId, cmd };
    const request = types.MapleMarketOperateRequest.encode(payload).finish();
    const writes = action === 'claimSeed' || action === 'sell' || action === 'exchange' || action === 'claimCommission';
    if (writes) markWriteStart();
    const response = await sendMsgAsync(SERVICE, 'Operate', request);
    const reply = types.ActivityOperateReply.decode(response.body);
    if (String(reply.activity_id) !== activityId || toNum(reply.operate_type) !== cmd
        || String(reply.data?.activity?.activity_id) !== activityId || !reply[field]) {
        if (writes) fail('MAPLE_MARKET_RESULT_UNKNOWN', '操作结果待核对，请刷新活动状态');
        fail('MAPLE_MARKET_UNAVAILABLE', '以薯换福返回的数据不完整，请刷新重试');
    }
    return { result: reply[field], market: reply.data.maple_market };
}

export interface MapleMarketQuote {
    basePrice: number;
    boost: number;
    unitPrice: number;
    complete: boolean;
    tier: string | null;
    canSell: boolean;
    remainingQuota: number;
    ownerName: string;
}

async function getShopQuote(gid: number, forFriend = false): Promise<MapleMarketQuote | null> {
    const { result } = await operate('getShop', { target_gid: gid });
    if (!result.shop) {
        if (forFriend) return null;
        fail('MAPLE_MARKET_UNAVAILABLE', '当前收购价暂不可用');
    }
    const basePrice = toNum(result.shop.base_price);
    const boost = toNum(result.shop.boost_value);
    const ownerGid = toNum(result.shop.owner?.gid);
    if (forFriend && basePrice <= 0 && boost <= 0) {
        if (ownerGid > 0 && ownerGid !== gid) {
            fail('MAPLE_MARKET_OWNER_MISMATCH', '报价回包中的铺主不一致');
        }
        return null;
    }
    if (forFriend && ownerGid !== gid) {
        fail('MAPLE_MARKET_OWNER_MISMATCH', '报价回包中的铺主不一致');
    }
    const tier = config.priceTiers.find(entry => entry.min <= basePrice && basePrice <= entry.max)?.name || null;
    return {
        basePrice,
        boost,
        unitPrice: basePrice + boost,
        complete: basePrice > 0 && boost > 0,
        tier,
        canSell: result.can_sell === true,
        remainingQuota: toNum(result.shop.remain_quota),
        ownerName: String(result.shop.owner?.name || '').trim(),
    };
}

function stock(items: any[], itemId: number) {
    return items.reduce((total: number, item: any) => (
        toNum(item.id) === itemId ? total + toNum(item.count) : total
    ), 0);
}

function sellableStock(items: any[], reserved: string) {
    const unlocked = stock(items.filter(item => !isItemLocked(item)), cropItemId);
    return Math.max(0, unlocked - toNum(reserved));
}

async function getCatalog() {
    const { result } = await operate('getGoods');
    const goods = result.goods.map((row: any) => {
        const id = toNum(row.goods_id);
        const definition = goodsById.get(id);
        const limitType = toNum(row.limit_type);
        const purchased = toNum(limitType === 1 ? row.purchased_daily : row.purchased_total);
        const limitTimes = limitType > 0 ? toNum(row.limit_times) : null;
        return {
            id, name: definition?.name || `商品 #${id}`,
            items: definition?.items.map(item => ({
                ...item,
                name: getItemById(item.id)?.name || `物品 #${item.id}`,
                image: getItemImageById(item.id),
            })) || [],
            price: toNum(row.activity_coin_price), limitType, limitTimes,
            remaining: limitTimes !== null ? Math.max(0, limitTimes - purchased) : null,
            exchangeable: !!definition && row.exchangeable === true,
        };
    });
    return { goods, coinBalance: toNum(result.activity_coin) };
}

async function getMapleMarketActivity() {
    const progress = await getMarketProgress();
    const open = progress.phase === 'active' || progress.phase === 'settlement';
    const [quote, catalog, bag] = await Promise.all([
        progress.phase === 'active' ? getShopQuote(getUserState().gid) : null,
        open ? getCatalog() : null,
        open ? getBag() : null,
    ]);
    const bagItems = bag ? getBagItems(bag) : [];
    return {
        ...progress,
        coinBalance: catalog?.coinBalance ?? progress.coinBalance,
        quote, goods: catalog?.goods ?? [],
        seedStock: stock(bagItems, seedItemId),
        cropStock: stock(bagItems, cropItemId),
        sellableCropStock: sellableStock(bagItems, forCurrentAccount().reserved(`item:${cropItemId}`)),
    };
}

async function claimMapleMarketSeed() {
    const progress = await getMarketProgress();
    if (!progress.canClaimSeed) {
        return { status: 'skipped' as const, data: null, message: progress.seedClaimed ? '今日红薯种子已领取' : '当前没有可领取的红薯种子' };
    }
    const { result, market } = await operate('claimSeed');
    const id = toNum(result.seed?.id);
    const count = toNum(result.seed?.count);
    if (id !== seedItemId || count <= 0 || market?.daily_state?.seed_claimed !== true) {
        fail('MAPLE_MARKET_RESULT_UNKNOWN', '领种结果待核对，请刷新活动状态');
    }
    invalidateActivityListReply();
    return { status: 'confirmed' as const, data: { activityId: groupId, seed: { id, count, name: '红薯种子' } } };
}

async function sellMapleMarketCrop(
    count: number,
    expectedUnitPrice: number,
    targetGid?: number,
    options?: { onQuote?: (quote: MapleMarketQuote | null) => void },
) {
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice < 1) {
        fail('INVALID_MAPLE_MARKET_SALE', '请填写有效的出售数量和收购价');
    }
    const reservations = forCurrentAccount();
    return reservations.withLock(async () => {
        const progress = await getMarketProgress();
        if (progress.phase !== 'active') fail('MAPLE_MARKET_SALE_UNAVAILABLE', '当前阶段无法出售蜜薯');
        const forFriend = targetGid !== undefined;
        const gid = targetGid ?? getUserState().gid;
        const [bag, quote] = await Promise.all([getBag({ fresh: true }), getShopQuote(gid, forFriend)]);
        options?.onQuote?.(quote);
        if (!quote?.canSell) fail('MAPLE_MARKET_SALE_UNAVAILABLE', '当前小铺无法收购蜜薯');
        if (quote.unitPrice !== expectedUnitPrice) fail('MAPLE_MARKET_PRICE_CHANGED', '收购价已变化，请刷新确认');
        if (forFriend && count > quote.remainingQuota) {
            fail('MAPLE_MARKET_QUOTA_CHANGED', '铺子剩余接收额度不足，请刷新报价');
        }
        if (count > sellableStock(getBagItems(bag), reservations.reserved(`item:${cropItemId}`))) {
            fail('MAPLE_MARKET_STOCK_CHANGED', '可用蜜薯不足，请刷新库存');
        }

        const { result, market } = await operate('sell', { target_gid: gid, sell_count: count });
        const sold = toNum(result.sold_count);
        const unitPrice = toNum(result.final_price);
        const income = toNum(result.activity_coin_income);
        const coinBalance = toNum(result.activity_coin);
        if (sold !== count || unitPrice <= 0 || income !== sold * unitPrice
            || !market || toNum(market.activity_coin) !== coinBalance || coinBalance < income) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '出售结果待核对，请刷新活动状态');
        }
        return { sold, unitPrice, income, coinBalance, ...(forFriend ? { remainingQuota: toNum(result.remain_quota) } : {}) };
    });
}

async function exchangeMapleMarketGoods(goodsId: number, count: number, expectedUnitPrice: number) {
    if (!Number.isSafeInteger(goodsId) || goodsId < 1 || !Number.isSafeInteger(count) || count < 1
        || !Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice < 1) {
        fail('INVALID_MAPLE_MARKET_EXCHANGE', '请确认有效的兑换商品、数量和价格');
    }
    const reservations = forCurrentAccount();
    return reservations.withLock(async () => {
        const progress = await getMarketProgress();
        if (progress.phase !== 'active' && progress.phase !== 'settlement') {
            fail('MAPLE_MARKET_EXCHANGE_UNAVAILABLE', '当前阶段无法兑换商品');
        }
        const catalog = await getCatalog();
        const offer = catalog.goods.find((goods: { id: number }) => goods.id === goodsId);
        if (!offer?.exchangeable) fail('MAPLE_MARKET_EXCHANGE_UNAVAILABLE', '该商品当前无法兑换');
        if (offer.price !== expectedUnitPrice) fail('MAPLE_MARKET_PRICE_CHANGED', '商品价格已变化，请刷新确认');
        if (offer.remaining !== null && count > offer.remaining) fail('MAPLE_MARKET_GOODS_LIMIT', '兑换数量超过剩余限购');
        const cost = count * offer.price;
        if (cost > catalog.coinBalance - toNum(reservations.reserved(`item:${coinItemId}`))) {
            fail('MAPLE_MARKET_COIN_INSUFFICIENT', '可用福气币不足');
        }

        const { result, market } = await operate('exchange', { goods_id: goodsId, exchange_count: count });
        const items = result.items;
        const coinBalance = toNum(result.activity_coin);
        const received = new Map<number, number>();
        for (const item of items) {
            const id = toNum(item.id);
            received.set(id, (received.get(id) || 0) + toNum(item.count));
        }
        if (toNum(result.activity_coin_cost) !== cost || !market || toNum(market.activity_coin) !== coinBalance
            || received.size !== offer.items.length
            || !offer.items.every((item: { id: number; count: number }) => received.get(item.id) === item.count * count)) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '兑换结果待核对，请刷新活动状态');
        }
        return { goodsId, count, cost, coinBalance, items: offer.items.map((item: { id: number; count: number; name: string }) => ({
            ...item, count: item.count * count,
        })) };
    });
}

async function getMapleMarketPurchaseLog() {
    const progress = await getMarketProgress();
    if (progress.phase !== 'active' && progress.phase !== 'settlement') {
        fail('MAPLE_MARKET_UNAVAILABLE', '当前阶段暂无收购记录');
    }
    const { result } = await operate('getPurchaseLog');
    const records = (result.records || [])
        .map((row: any) => {
            const sellerGid = toNum(row.seller_gid);
            return {
                timestamp: toNum(row.timestamp) * 1000,
                sellerGid,
                sellerName: String(row.seller_name || '').trim() || `GID:${sellerGid}`,
                sellerAvatar: String(row.seller_avatar || ''),
                sellerLevel: toNum(row.seller_level),
                soldCount: toNum(row.sold_count),
                income: toNum(row.income),
                commission: toNum(row.commission),
            };
        })
        .sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp);
    return { records };
}

async function claimMapleMarketCommission() {
    return forCurrentAccount().withLock(async () => {
        const progress = await getMarketProgress();
        if (!progress.canClaimCommission) {
            return { status: 'skipped' as const, data: null, message: '当前没有可领取的小铺提成' };
        }
        const { result, market } = await operate('claimCommission');
        const claimedCoin = toNum(result.claimed_coin);
        const claimedCount = toNum(result.claimed_count);
        const coinBalance = toNum(result.activity_coin);
        if (claimedCoin <= 0 || claimedCount <= 0 || !market
            || toNum(market.activity_coin) !== coinBalance
            || coinBalance < claimedCoin
            || toNum(market.pending_commission_coin) !== 0) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '提成领取结果待核对，请刷新活动状态');
        }
        invalidateActivityListReply();
        return {
            status: 'confirmed' as const,
            data: { activityId: groupId, claimedCoin, claimedCount, coinBalance },
        };
    });
}

module.exports = {
    getMapleMarketActivity,
    getMarketProgress,
    getShopQuote,
    getMapleMarketPurchaseLog,
    claimMapleMarketSeed,
    claimMapleMarketCommission,
    sellMapleMarketCrop,
    exchangeMapleMarketGoods,
};
