export {};
/**
 * 邀请码 / 好友号池处理模块
 * 注意：此功能仅在微信环境下有效
 *
 * 两条链路（都已实测）：
 * 1. 申请添加：VisitService.Enter(reason=5, share_key) 拿 apply_token → FriendService.ApplyFriend，
 *    需要「点击分享链接可拜访好友」开关（字段 6 = 1），对方要点同意。
 * 2. 强制添加：只发 UserService.ReportArkClick(sharer_id, sharer_open_id, scene_id,
 *    share_cfg_id, share_key)，服务端几秒内直接绑定好友，无需对方同意。
 *    要求 openid 与 share_key 的主人一致；openid 缺失时服务端不会绑定。
 */

const { CONFIG } = require('../config/config');
const { getShareFilePath } = require('../config/runtime-paths');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, log, logWarn, sleep } = require('../utils/utils');
const { readTextFile, writeTextFileAtomic } = require('./json-db');

/** 微信分享卡片场景号（卡片默认 1007，登录分享链接是 1256） */
const ARK_SCENE_ID = '1007';

/** dog_id → 犬种，用于号池资料识别（反编译 dogpb 常量） */
const DOG_BREEDS: Record<number, string> = {
    0: '无狗',
    90001: '田园犬',
    90002: '牧羊犬',
    90003: '斑点狗',
    90011: '柯基',
    90021: '护主犬',
};

function dogBreedName(dogId: unknown): string {
    const id = Number(dogId) || 0;
    return DOG_BREEDS[id] || (id > 0 ? `未知(${id})` : '无狗');
}

interface ParsedShareLink {
    uid: string | null;
    openid: string | null;
    shareSource: string | null;
    docId: string | null;
    /** BUGDey v2.18.12：分享卡片 32 位 key，Enter(reason=5) 拿 apply_token 必需 */
    shareKey: string | null;
    cardTime: string | null;
}

/**
 * 解析分享链接，提取 uid 和 openid
 * 格式: ?uid=xxx&openid=xxx&share_source=xxx&doc_id=xxx
 */
function parseShareLink(link: string): ParsedShareLink {
    const result: ParsedShareLink = { uid: null, openid: null, shareSource: null, docId: null, shareKey: null, cardTime: null };

    // 只取问号之后的查询串：既支持 `?uid=...` 这种约定格式，
    // 也能处理用户整段粘贴过来的分享链接（`https://.../?uid=...`）。
    const raw: string = String(link || '');
    const queryStart: number = raw.indexOf('?');
    const queryStr: string = queryStart >= 0 ? raw.slice(queryStart + 1) : raw;

    // 解析参数
    const params = new URLSearchParams(queryStr);
    result.uid = params.get('uid');
    result.openid = params.get('openid');
    result.shareSource = params.get('share_source');
    result.docId = params.get('doc_id');
    result.shareKey = params.get('share_key');
    result.cardTime = params.get('card_time');

    return result;
}

/**
 * 读取 share.txt 文件并去重
 */
function readShareFile(): ParsedShareLink[] {
    const shareFilePath: string = getShareFilePath();

    try {
        const content: string = readTextFile(shareFilePath, '');
        const lines: string[] = content.split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0 && line.includes('openid='));

        const invites: ParsedShareLink[] = [];
        const seenUids: Set<string> = new Set();  // 用于去重

        for (const line of lines) {
            const parsed: ParsedShareLink = parseShareLink(line);
            if (parsed.openid && parsed.uid) {
                // 按 uid 去重，同一个用户只处理一次
                if (!seenUids.has(parsed.uid)) {
                    seenUids.add(parsed.uid);
                    invites.push(parsed);
                }
            }
        }

        return invites;
    } catch (e: any) {
        logWarn('邀请', `读取 share.txt 失败: ${e.message}`);
        return [];
    }
}

/**
 * 发送 ReportArkClick 请求（= 已登录状态下点开对方分享卡片）。
 *
 * 字段号以反编译源码为准：sharer_id=1 / sharer_open_id=2 / scene_id=3 /
 * share_cfg_id=4 / share_key=5。旧版把 3、4 写反且没带 share_key，
 * 服务端只会当成一次无效点击；带上正确的 share_key 后，服务端会直接
 * 把对方加进好友列表（免同意直加），回包 relation.is_friend 可验证结果。
 *
 * 关键约束：sharer_open_id 必须与 share_key 的主人一致，否则服务端不绑定。
 */
async function sendReportArkClick(
    sharerId: string | null,
    sharerOpenId: string | null,
    shareSource: string | null,
    shareKey: string | null = null,
    sceneId: string = ARK_SCENE_ID,
): Promise<any> {
    const body: Uint8Array = types.ReportArkClickRequest.encode(types.ReportArkClickRequest.create({
        sharer_id: toLong(sharerId),
        sharer_open_id: String(sharerOpenId || ''),
        scene_id: String(sceneId || ARK_SCENE_ID),
        share_cfg_id: toLong(shareSource || 0),
        share_key: String(shareKey || ''),
    })).finish();

    const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'ReportArkClick', body);
    try {
        return types.ReportArkClickReply.decode(replyBody || Buffer.alloc(0));
    } catch {
        return {};
    }
}

/**
 * 强制添加（免同意直加）：只发 ReportArkClick，不发申请、不需要 Enter。
 * 依据：反编译的热启动流程，玩家点开分享卡片时游戏只发这一个请求，
 * 服务端随即完成绑定；本项目旧链路缺 share_key 所以一直没生效。
 */
async function forceAddSharer(item: any): Promise<any> {
    const uid = String(item?.uid || '');
    const shareKey = String(item?.shareKey || '');
    const openid = String(item?.openid || '');
    if (!uid) return { uid, ok: false, skipped: true, error: '缺少 uid' };
    if (!shareKey) return { uid, ok: false, skipped: true, error: '缺少 share_key，无法强制添加' };
    if (!openid) return { uid, ok: false, skipped: true, error: '缺少 openid，无法强制添加（请用原始分享链接导入）' };

    const reply: any = await sendReportArkClick(uid, openid, item.shareSource, shareKey);
    const isFriend = !!(reply?.relation && reply.relation.is_friend);
    return {
        uid, ok: true, isFriend,
        name: String(item?.name || ''),
        level: Number(item?.level) || 0,
        mode: 'force',
    };
}

// 请求间隔时间（毫秒）
const INVITE_REQUEST_DELAY: number = 2000;

/**
 * 处理邀请码列表
 * 仅在微信环境下执行
 */
async function processInviteCodes(): Promise<void> {
    if (CONFIG.platform !== 'wx') {
        log('邀请', '当前为 QQ 环境，跳过邀请码处理（仅微信支持）');
        return;
    }
    const invites = readShareFile();
    if (!invites.length) return;

    // 新链路：带 share_key 的卡片走「Enter 拿令牌 → ApplyFriend」真正加好友。
    const sharers = invites.filter(invite => invite.shareKey);
    if (sharers.length) {
        log('邀请', `读取到 ${sharers.length} 个邀请码，开始自动发送好友申请...`);
        try {
            await applyInviteList(sharers, { delayMs: INVITE_REQUEST_DELAY });
        } catch (e: any) {
            logWarn('邀请', `批量加好友失败: ${e?.message || e}`);
        }
    }

    // 旧链路兜底：没有 share_key 的链接只能上报点击（不会真正加好友）。
    const legacy = invites.filter(invite => !invite.shareKey);
    for (let i = 0; i < legacy.length; i += 1) {
        const invite = legacy[i];
        try {
            await sendReportArkClick(invite.uid, invite.openid, invite.shareSource);
            log('邀请', `[${i + 1}/${legacy.length}] 已上报 uid=${invite.uid} 的分享点击`);
        } catch (e: any) {
            logWarn('邀请', `[${i + 1}/${legacy.length}] 上报 uid=${invite.uid} 失败: ${e?.message || e}`);
        }
        if (i < legacy.length - 1) await sleep(INVITE_REQUEST_DELAY);
    }
    clearShareFile();
}

/**
 * 清空已处理的邀请码文件
 */
function clearShareFile(): void {
    const shareFilePath: string = getShareFilePath();
    try {
        writeTextFileAtomic(shareFilePath, '');
        log('邀请', '已清空 share.txt');
    } catch {
        // 静默失败
    }
}


// ==================== 主动加好友（移植 BUGDey v2.18.12） ====================
// 旧链路只发 ReportArkClick（点击上报），不会真正发出好友申请。
// 抓包实证：先 VisitService.Enter(reason=5, share_key) 拿回包顶层 apply_token，
// 再 FriendService.ApplyFriend(gid, apply_token, source=0) 才是真正的加好友。
const DAILY_LIMIT_PATTERN = /1005027|好友申请已达上限|申请已达上限|达到上限|已达上限/;
const VISIT_SWITCH_PATTERN = /1002007|未打开拜访好友开关|拜访好友开关/;
const VISIT_SWITCH_HINT = '未开启「好友功能 · 点击分享链接可拜访好友」，请到游戏 设置 → 好友功能 打开后再试';
const ENTER_REASON_FROM_SHARE = 5;

let visitSwitchCache: { value: boolean | null; ts: number } = { value: null, ts: 0 };

function isDailyLimitError(message: unknown): boolean {
    return DAILY_LIMIT_PATTERN.test(String(message || ''));
}
function isVisitSwitchError(message: unknown): boolean {
    return VISIT_SWITCH_PATTERN.test(String(message || ''));
}
function currentAccountId(): string {
    return String(process.env.FARM_ACCOUNT_ID || '') || 'default';
}

/** 读「点击分享链接可拜访好友」开关（field 6）；读不到不影响主流程。 */
async function readVisitSwitchEnabled(forceRefresh = false): Promise<boolean | null> {
    if (!forceRefresh && visitSwitchCache.value !== null && Date.now() - visitSwitchCache.ts < 5 * 60 * 1000)
        return visitSwitchCache.value;
    try {
        if (!types.GetUserSettingsRequest || !types.GetUserSettingsReply) return null;
        const body = types.GetUserSettingsRequest.encode(types.GetUserSettingsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'GetUserSettings', body);
        const reply: any = types.GetUserSettingsReply.decode(replyBody || Buffer.alloc(0));
        const enabled = Number(reply?.settings?.visit_by_share_key || 0) === 1;
        visitSwitchCache = { value: enabled, ts: Date.now() };
        return enabled;
    } catch (e: any) {
        logWarn('邀请', `读取好友拜访开关失败（不影响申请）: ${e?.message || e}`);
        return null;
    }
}

/** 自动打开拜访好友开关：SetUserSettings{field 6 = 1}，写完复读确认。 */
async function enableVisitSwitch(): Promise<boolean> {
    visitSwitchCache = { value: null, ts: 0 };
    try {
        if (!types.SetUserSettingsRequest) return false;
        const body = types.SetUserSettingsRequest.encode(types.SetUserSettingsRequest.create({ visit_by_share_key: 1 })).finish();
        await sendMsgAsync('gamepb.userpb.UserService', 'SetUserSettings', body);
    } catch (e: any) {
        logWarn('邀请', `自动打开拜访好友开关失败: ${e?.message || e}`);
        return false;
    }
    return await readVisitSwitchEnabled(true) === true;
}

async function ensureVisitSwitch(): Promise<boolean | null> {
    const state = await readVisitSwitchEnabled();
    if (state !== false) return state;
    log('邀请', '检测到「点击分享链接可拜访好友」未开启，自动打开...');
    const opened = await enableVisitSwitch();
    if (opened) log('邀请', '已自动开启拜访好友开关，继续加好友');
    return opened;
}

/** 进入对方农场（只读），拿昵称/等级/犬种与好友申请令牌，随后立刻离开。 */
async function enterSharer(uid: string, shareKey: string): Promise<{
    level: number; name: string; gid: string; applyToken: string;
    isFriend: boolean; isTourist: boolean; dogBreed: string;
}> {
    const request = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(uid),
        reason: ENTER_REASON_FROM_SHARE,
        share_key: String(shareKey || ''),
    })).finish();
    const { body } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', request);
    const reply: any = types.VisitEnterReply.decode(body || Buffer.alloc(0));
    const basic = reply?.basic || {};
    const info = {
        level: Number(basic.level || 0),
        name: String(basic.name || ''),
        gid: String(basic.gid || uid),
        applyToken: String(reply?.apply_token || ''),
        isFriend: !!(reply?.host_relation && reply.host_relation.is_friend),
        isTourist: !!reply?.is_tourist,
        dogBreed: dogBreedName(reply?.brief_dog_info?.dog_id),
    };
    try {
        const leave = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({ host_gid: toLong(uid) })).finish();
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', leave);
    } catch {}
    return info;
}

/** 真正发出好友申请：必须携带 Enter 回包的 apply_token。 */
async function sendApplyFriend(uid: string, applyToken: string): Promise<void> {
    const body = types.ApplyFriendRequest.encode(types.ApplyFriendRequest.create({
        gid: toLong(uid), apply_token: String(applyToken || ''), source: 0,
    })).finish();
    await sendMsgAsync('gamepb.friendpb.FriendService', 'ApplyFriend', body);
}

/** 对单张分享卡片执行完整加好友流程。 */
async function sendFriendRequestToSharer(item: any, opts: { minLevel?: number; allowUnknownLevel?: boolean } = {}): Promise<any> {
    const uid = String(item?.uid || '');
    const shareKey = String(item?.shareKey || '');
    if (!uid) return { uid, ok: false, skipped: true, error: '缺少 uid' };
    if (!shareKey) return { uid, ok: false, skipped: true, error: '缺少 share_key，无法获取申请令牌' };

    const info = await enterSharer(uid, shareKey);
    // Enter 顺手把昵称/等级/犬种回填进号池，省一次单独识别。
    try {
        require('./friend/pool').updateProfile(uid, { name: info.name, level: info.level, dogBreed: info.dogBreed });
    } catch {}

    if (info.isFriend)
        return { uid, ok: false, skipped: true, friend: true, level: info.level, name: info.name, error: '已是好友' };
    const minLevel = Number(opts.minLevel) > 0 ? Math.floor(Number(opts.minLevel)) : 0;
    if (minLevel > 0 && opts.allowUnknownLevel !== true && info.level > 0 && info.level < minLevel)
        return { uid, ok: false, skipped: true, level: info.level, name: info.name, error: `农场等级 ${info.level} < ${minLevel}` };
    if (!info.applyToken)
        return { uid, ok: false, skipped: true, level: info.level, name: info.name, error: '未拿到申请令牌（对方可能关闭了拜访权限）' };

    await sendApplyFriend(uid, info.applyToken);
    return { uid, ok: true, level: info.level, name: info.name, dogBreed: info.dogBreed };
}

/** 把用户粘贴的分享链接/文本导入号池（全账号共享）。 */
function importShareText(text: string): { added: number; updated: number; parsed: number } {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const pool = require('./friend/pool');
    const items = lines.map((line: string) => {
        const parsed = parseShareLink(line);
        return {
            uid: parsed.uid || '',
            openid: parsed.openid || '',
            shareSource: parsed.shareSource || '',
            docId: parsed.docId || '',
            shareKey: parsed.shareKey || '',
            cardTime: parsed.cardTime || '',
        };
    }).filter((item: any) => item.uid && item.openid);
    const result = items.length ? pool.upsertItems(items) : { added: 0, updated: 0 };
    return { ...result, parsed: items.length };
}

/**
 * 批量加好友，两种模式：
 * - apply（默认）：号池逐条 Enter → ApplyFriend，需对方同意；撞每日上限立即停整批。
 * - force：号池逐条 ReportArkClick，服务端直接绑定，无需同意；必须带 openid。
 * 已是好友 / 待通过 / 已判定死链的直接跳过，状态按账号隔离。
 */
async function applyInviteList(items: any[], opts: any = {}): Promise<any> {
    const pool = require('./friend/pool');
    const accountId = String(opts.accountId || currentAccountId());
    const mode = String(opts.mode || 'apply').toLowerCase() === 'force' ? 'force' : 'apply';
    const limitMs = Math.max(0, Number(opts.delayMs ?? INVITE_REQUEST_DELAY));
    const maxCount = Math.max(0, Number(opts.limit) || 0);
    const result = {
        mode, total: 0, applied: 0, skipped: 0, failed: 0, friend: 0,
        aborted: '', errors: [] as any[],
    };

    if (pool.dailyLimitBlocked(accountId)) {
        result.aborted = '今日好友申请已达上限，明天再试';
        log('邀请', result.aborted);
        return result;
    }
    // 强制模式不发 Enter，不需要「点击分享链接可拜访好友」开关。
    if (mode === 'apply') {
        const switchOk = await ensureVisitSwitch();
        if (switchOk === false) {
            result.aborted = VISIT_SWITCH_HINT;
            logWarn('邀请', result.aborted);
            return result;
        }
    }

    const statusMap = pool.getStatusMap(accountId);
    const friendGids = pool.loadFriendGidSet();
    const targets = (Array.isArray(items) ? items : []).filter((item: any) => {
        const uid = String(item?.uid || '');
        const status = statusMap[uid] || 'new';
        if (!item?.shareKey || !uid) return false;
        if (status === 'friend' || status === 'pending' || friendGids.has(uid)) return false;
        if (mode === 'force' && !String(item?.openid || '').trim()) return false;
        return true;
    });
    result.total = maxCount > 0 ? Math.min(targets.length, maxCount) : targets.length;
    if (result.total > 0) log('邀请', `开始${mode === 'force' ? '强制' : '申请'}添加好友：${result.total} 个候选`);

    for (let i = 0; i < result.total; i += 1) {
        const item = targets[i];
        try {
            const outcome = mode === 'force'
                ? await forceAddSharer(item)
                : await sendFriendRequestToSharer(item, opts);
            if (outcome.skipped) {
                result.skipped += 1;
                if (outcome.friend) pool.markFriend(accountId, String(item.uid));
                else if (outcome.error) pool.markDead(accountId, String(item.uid), String(outcome.error));
            } else if (outcome.ok) {
                if (mode === 'force') {
                    // 直加成功：服务端已绑定，直接记为好友。
                    pool.markFriend(accountId, String(item.uid));
                    pool.markArkApplied(accountId, String(item.uid), !!outcome.isFriend);
                    result.friend += 1;
                    log('邀请', `[${i + 1}/${result.total}] 已强制添加 uid=${item.uid}${outcome.name ? `（${outcome.name}）` : ''} isFriend=${outcome.isFriend}`);
                } else {
                    pool.markApplied(accountId, String(item.uid));
                    result.applied += 1;
                    log('邀请', `[${i + 1}/${result.total}] 已向 uid=${item.uid} 发送好友申请`);
                }
            }
        } catch (e: any) {
            const message = String(e?.message || e || '');
            if (isDailyLimitError(message)) {
                pool.markDailyLimit(accountId, message);
                result.aborted = '今日好友申请已达上限，已停止本批次';
                logWarn('邀请', result.aborted);
                break;
            }
            if (isVisitSwitchError(message)) {
                result.aborted = VISIT_SWITCH_HINT;
                logWarn('邀请', result.aborted);
                break;
            }
            result.failed += 1;
            result.errors.push({ uid: item.uid, error: message });
            pool.markDead(accountId, String(item.uid), message);
            logWarn('邀请', `[${i + 1}/${result.total}] uid=${item.uid} ${mode === 'force' ? '强制添加' : '申请'}失败: ${message}`);
        }
        if (i < result.total - 1 && limitMs > 0) await sleep(limitMs);
    }
    log('邀请', `批量加好友完成（${mode === 'force' ? '强制' : '申请'}）：${mode === 'force' ? `${result.friend} 已直加` : `${result.applied} 已申请`} / ${result.skipped} 跳过 / ${result.failed} 失败${result.aborted ? `，中断：${result.aborted}` : ''}`);
    return result;
}

function getFriendPoolSnapshot(accountId?: string): any {
    return require('./friend/pool').snapshot(String(accountId || currentAccountId()));
}

module.exports = {
    parseShareLink,
    readShareFile,
    sendReportArkClick,
    processInviteCodes,
    clearShareFile,
    // 主动加好友（BUGDey v2.18.12 + 强制直加链路）
    importShareText,
    applyInviteList,
    getFriendPoolSnapshot,
    ensureVisitSwitch,
    sendFriendRequestToSharer,
    forceAddSharer,
    dogBreedName,
};
