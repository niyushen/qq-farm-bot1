import crypto from 'node:crypto';
import { getNativeWxLoginCode } from './native-protocol';

const QR_CONNECT_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const QR_IMAGE_BASE = 'https://open.weixin.qq.com/connect/qrcode/';
const QR_POLL_URL = 'https://long.open.weixin.qq.com/connect/l/qrconnect';
const CALLBACK_URL = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth';
const LOGIN_BUFFER_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth';
const REFRESH_TOKEN_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_refresh_token_auth';
const USER_INFO_URL = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_get_user_info';
const OAUTH_APP_ID = 'wxd44977328b36e647';
const USER_AGENT = 'Mozilla/5.0';
const LOGIN_BUFFER_ACCESS_KEY = 'wgrdg373hy26ww2';
const DEFAULT_CREDENTIAL_EXPIRES_IN_SECONDS = 7200;

export type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';

export interface WxLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    oauthCode?: string;
    openid?: string;
    nickname?: string;
    loginBuffer?: string;
    accesstoken?: string;
    refreshtoken?: string;
    credentialExpiresIn?: number;
    credentialExpiresAt?: number;
    refreshTokenObservedAt?: number;
}

/** 从 login_buffer 响应中提取凭证值（兼容 snake_case / camelCase 两种结构） */
function pickLoginBuffer(data: unknown): string {
    const source = (data && typeof data === 'object') ? data as Record<string, any> : {};
    const snake = (source.ext_info as any)?.list_s?.login_buffer?.value;
    const camel = (source.extInfo as any)?.listS?.loginBuffer?.value;
    const value = (Array.isArray(snake) ? snake[0] : undefined)
        || (Array.isArray(camel) ? camel[0] : undefined)
        || '';
    return typeof value === 'string' ? value : '';
}

function positiveSeconds(value: unknown, fallback = DEFAULT_CREDENTIAL_EXPIRES_IN_SECONDS): number {
    const seconds = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/** 把滚动后的新凭证附到错误对象上：即使换 loginBuffer 失败，调用方也必须保存新 token */
function attachRotatedCredentials(error: unknown, refreshToken: string, accessToken: string, lifetime: Record<string, any> = {}): Error {
    const credentialError = (error instanceof Error) ? error : new Error(String(error));
    (credentialError as any).refreshtoken = refreshToken;
    (credentialError as any).accesstoken = accessToken;
    (credentialError as any).credentialExpiresAt = Number(lifetime.credentialExpiresAt) || 0;
    (credentialError as any).credentialExpiresIn = Number(lifetime.credentialExpiresIn) || 0;
    (credentialError as any).refreshTokenRotated = lifetime.refreshTokenRotated === true;
    (credentialError as any).tokenRefreshSucceeded = true;
    return credentialError;
}

/** 只保留阶段和数字状态码：上游文案可能回显 token，不能落盘或往外传。 */
function credentialResponseError(stage: string, data: any): Error {
    const rawCode = data && data.code;
    const code = ((typeof rawCode === 'number') || (typeof rawCode === 'string' && /^-?\d+$/.test(rawCode)))
        && Number.isSafeInteger(Number(rawCode)) ? Number(rawCode) : null;
    const reason = code === 40188 ? 'invalid scope' : 'credential response rejected';
    const error = new Error(`WeChat ${stage} failed: code=${code ?? 'unknown'} ${reason}`) as Error & { wxStage?: string; wxCode?: number | null };
    error.wxStage = stage;
    error.wxCode = code;
    return error;
}

interface HttpResult {
    status: number;
    body: Buffer;
    headers: Headers;
}

function cookieHeader(cookies: Map<string, string>): string {
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
    const headerValue = headers.get('set-cookie');
    const values = typeof (headers as any).getSetCookie === 'function'
        ? (headers as any).getSetCookie()
        : headerValue ? [headerValue] : [];
    for (const value of values) {
        const pair = value.split(';', 1)[0].trim();
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
}

async function request(url: string, cookies: Map<string, string>, init: RequestInit = {}, timeout = 35_000): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        let currentUrl = url;
        let method = init.method || 'GET';
        let body = init.body;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const headers = new Headers(init.headers);
            headers.set('User-Agent', USER_AGENT);
            if (cookies.size) headers.set('Cookie', cookieHeader(cookies));
            const response = await fetch(currentUrl, { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
            storeCookies(cookies, response.headers);
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) {
                return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
            }
            currentUrl = new URL(location, currentUrl).toString();
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
                method = 'GET';
                body = undefined;
            }
        }
        throw new Error('Too many redirects while contacting WeChat');
    } finally {
        clearTimeout(timer);
    }
}

function requiredCookie(cookies: Map<string, string>, name: string): string {
    const value = cookies.get(name);
    if (!value) throw new Error(`WeChat OAuth callback did not provide ${name}`);
    return value;
}

/**
 * Keep the OAuth callback parser as a fallback. The authoritative profile is
 * fetched from pcyyb_get_user_info after the login buffer is issued.
 */
function extractNickname(body: Buffer): string | undefined {
    let callbackData: unknown;
    try {
        callbackData = JSON.parse(body.toString('utf8'));
    } catch {
        return undefined;
    }

    if (!callbackData || typeof callbackData !== 'object') return undefined;
    let userInfo = (callbackData as Record<string, unknown>).user_info;
    if (typeof userInfo === 'string') {
        try {
            userInfo = JSON.parse(userInfo);
        } catch {
            return undefined;
        }
    }
    if (!userInfo || typeof userInfo !== 'object') return undefined;

    const info = userInfo as Record<string, unknown>;
    for (const key of ['nickname', 'nick_name', 'nickName']) {
        const value = info[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function extractUserInfoNickname(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const info = data as Record<string, unknown>;
    for (const key of ['nick_name', 'nickname', 'nickName']) {
        const value = info[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }

    // Some responses wrap the profile in user_info; the Go endpoint normally
    // returns nick_name at the top level, but accepting both keeps parsing
    // compatible with deployed response variants.
    let nested = info.user_info;
    if (typeof nested === 'string') {
        try {
            nested = JSON.parse(nested);
        } catch {
            nested = undefined;
        }
    }
    return extractUserInfoNickname(nested);
}

async function fetchUserInfo(
    cookies: Map<string, string>,
    openid: string,
    accessToken: string,
): Promise<unknown> {
    const timestamp = String(Date.now());
    const nonce = String(crypto.randomInt(0, 10000));
    const requestId = String(crypto.randomInt(1000, 10000));
    const signature = crypto.createHash('md5').update(`${timestamp}${nonce}`).digest('hex');
    const response = await request(USER_INFO_URL, cookies, {
        headers: {
            'Ual-Access-Access-Token': accessToken,
            'Ual-Access-Login-Type': '2',
            'Ual-Access-Openid': openid,
            'Ual-Access-Businessid': 'pc_yyb',
            'Ual-Access-Guid': 'web',
            'Ual-Access-Nonce': nonce,
            'Ual-Access-Requestid': requestId,
            'Ual-Access-Signature': signature,
            'Ual-Access-Timestamp': timestamp,
        },
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Unable to obtain WeChat user info (HTTP ${response.status})`);
    }
    return JSON.parse(response.body.toString('utf8'));
}

export class WxLoginService {
    async createQrSession(): Promise<{ session: WxLoginSession; qr: Buffer }> {
        const cookies = new Map<string, string>();
        const params = new URLSearchParams({
            appid: OAUTH_APP_ID,
            redirect_uri: `${CALLBACK_URL}?login_type=WX`,
            response_type: 'code',
            scope: 'snsapi_login,snsapi_runtime_pcsdk',
            state: 'web',
            fast_login: '1',
            self_redirect: 'true',
        });
        const page = await request(`${QR_CONNECT_URL}?${params}`, cookies);
        if (page.status < 200 || page.status >= 300) throw new Error(`Unable to create WeChat QR session (HTTP ${page.status})`);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString('utf8'))?.[1];
        if (!uuid) throw new Error('Unable to parse the WeChat QR session');
        const qr = await request(`${QR_IMAGE_BASE}${encodeURIComponent(uuid)}`, cookies);
        if (qr.status < 200 || qr.status >= 300) throw new Error(`Unable to download WeChat QR image (HTTP ${qr.status})`);
        return { session: { cookies, uuid }, qr: qr.body };
    }

    async poll(session: WxLoginSession): Promise<ScanStatus> {
        if (session.oauthCode) return 'authorized';
        const params = new URLSearchParams({ uuid: session.uuid, _: String(Date.now()) });
        const response = await request(`${QR_POLL_URL}?${params}`, session.cookies, {}, 35_000);
        if (response.status < 200 || response.status >= 300) throw new Error(`WeChat QR polling failed (HTTP ${response.status})`);
        const body = response.body.toString('utf8');
        const errcode = /wx_errcode\s*=\s*(\d+)/.exec(body)?.[1];
        if (errcode === '408') return 'waiting';
        if (errcode === '404') return 'scanned';
        if (errcode === '403') return 'cancelled';
        if (errcode === '402') return 'expired';
        if (errcode === '405') {
            const code = /wx_code\s*=\s*'([^']+)'/.exec(body)?.[1];
            if (!code) throw new Error('WeChat authorization response did not include a code');
            session.oauthCode = code;
            return 'authorized';
        }
        throw new Error('Unrecognized WeChat QR polling response');
    }

    async confirm(session: WxLoginSession): Promise<{ openid: string; loginBuffer: string; refreshtoken: string; accesstoken: string; credentialExpiresAt: number; credentialExpiresIn: number; refreshTokenObservedAt: number }> {
        if (!session.oauthCode) throw new Error('Waiting for scan authorization');
        const params = new URLSearchParams({ login_type: 'WX', code: session.oauthCode, state: 'web' });
        const callback = await request(`${CALLBACK_URL}?${params}`, session.cookies);
        if (callback.status < 200 || callback.status >= 400) throw new Error(`WeChat authorization callback failed (HTTP ${callback.status})`);
        const nickname = extractNickname(callback.body);
        const openid = requiredCookie(session.cookies, 'openid');
        const accessToken = requiredCookie(session.cookies, 'accesstoken');
        // refreshtoken 可选（部分环境不回传）；存在则用于 loginBuffer 保活/续期（自动刷新 Code 依赖）
        const refreshToken = session.cookies.get('refreshtoken') || '';
        // 扫码回调 Cookie 里的 expires_in 是服务端给出的凭据有效期；必须在
        // cookies.clear() 之前取走，否则后续到期前续期调度没有基线。
        const credentialExpiresIn = positiveSeconds(session.cookies.get('expires_in'));
        const credentialExpiresAt = Date.now() + credentialExpiresIn * 1000;
        const payload = JSON.stringify({ extInfo: { listS: { unionid: { value: [openid] }, user_id: { value: [openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
        const timestamp = String(Date.now());
        const nonce = String(crypto.randomInt(1000, 10000));
        const signature = crypto.createHash('md5').update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest('hex');
        const response = await request(LOGIN_BUFFER_URL, session.cookies, {
            method: 'POST', body: payload,
            headers: { 'Content-Type': 'application/json', 'Ual-Access-Businessid': 'pc_yyb_auth', 'Ual-Access-Timestamp': timestamp, 'Ual-Access-Nonce': nonce, 'Ual-Access-Signature': signature },
        });
        if (response.status < 200 || response.status >= 300) throw new Error(`Unable to obtain WeChat login buffer (HTTP ${response.status})`);
        const data = JSON.parse(response.body.toString('utf8'));
        const loginBuffer = data?.code === 0 ? pickLoginBuffer(data) : '';
        if (typeof loginBuffer !== 'string' || !loginBuffer) throw new Error('WeChat login buffer response is invalid');
        let userInfoNickname: string | undefined;
        try {
            const userInfo = await fetchUserInfo(session.cookies, openid, accessToken);
            userInfoNickname = extractUserInfoNickname(userInfo);
        } catch {
            // The Go implementation treats profile lookup as best effort.
        }
        session.cookies.clear();
        session.openid = openid;
        session.nickname = userInfoNickname || nickname;
        session.loginBuffer = loginBuffer;
        session.accesstoken = accessToken;
        session.refreshtoken = refreshToken;
        session.credentialExpiresIn = credentialExpiresIn;
        session.credentialExpiresAt = credentialExpiresAt;
        session.refreshTokenObservedAt = refreshToken ? Date.now() : 0;
        return {
            openid,
            loginBuffer,
            refreshtoken: refreshToken,
            accesstoken: accessToken,
            credentialExpiresAt,
            credentialExpiresIn,
            refreshTokenObservedAt: session.refreshTokenObservedAt || 0,
        };
    }

    async issueCode(session: { loginBuffer?: string }, appId: string): Promise<string> {
        if (!session.loginBuffer) throw new Error('WeChat login session has not been confirmed');
        return getNativeWxLoginCode(session.loginBuffer, appId);
    }

    /**
     * 用 refreshtoken 滚动续期：刷新 accesstoken/refreshtoken → 用新凭证换新 loginBuffer。
     * 关键：loginBuffer 实际有效期 > 2h，而 refreshtoken 约 2h 过期——必须主动刷新（不等 loginBuffer 失效），
     * 否则 loginBuffer 失效时 refreshtoken 已过期，续期必然失败（code=-109），只能重新扫码。
     * 刷新成功后旧 refreshtoken 立即失效（滚动凭证）：即使换 loginBuffer 失败，
     * 错误对象上也带新 token，调用方必须持久化，否则永久陷入凭证失效。
     */
    async refreshLoginBuffer(
        session: { openid?: string; refreshtoken?: string; accesstoken?: string; loginBuffer?: string; cookies?: Map<string, string>; credentialExpiresIn?: number; credentialExpiresAt?: number; refreshTokenObservedAt?: number },
        options: {
            shouldContinue?: () => boolean;
            onCredentialsRefreshed?: (checkpoint: Record<string, any>) => Promise<void> | void;
        } = {},
    ): Promise<{ loginBuffer: string; refreshtoken: string; accesstoken: string; credentialExpiresAt: number; credentialExpiresIn: number; refreshTokenObservedAt: number; refreshTokenRotated: boolean }> {
        if (!session || !session.openid || !session.refreshtoken) {
            throw new Error('缺少刷新凭证（refreshtoken），请重新扫码登录');
        }
        // 字段必须 camelCase（userInfo/openId/refreshToken/accessToken/loginType），
        // 用 snake_case 服务器解析不到 refreshtoken → code=-109 "RefreshToken empty token"
        const payload = JSON.stringify({ userInfo: { openId: session.openid, refreshToken: session.refreshtoken, accessToken: session.accesstoken || '', loginType: 'WX' } });
        const timestamp = String(Date.now());
        const nonce = String(crypto.randomInt(1000, 10000));
        const signature = crypto.createHash('md5').update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest('hex');
        const cookies = session.cookies || new Map<string, string>();
        const response = await request(REFRESH_TOKEN_URL, cookies, {
            method: 'POST', body: payload,
            headers: {
                'Content-Type': 'application/json',
                'Ual-Access-Businessid': 'pc_yyb_auth',
                'Ual-Access-Timestamp': timestamp,
                'Ual-Access-Nonce': nonce,
                'Ual-Access-Signature': signature,
                'Cookie': `openid=${session.openid}; accesstoken=${session.accesstoken || ''}; refreshtoken=${session.refreshtoken}`,
            },
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Unable to refresh WeChat token (HTTP ${response.status})`);
        }
        const data = JSON.parse(response.body.toString('utf8'));
        if (data?.code !== 0) {
            throw credentialResponseError('refresh_token', data);
        }
        const info = data.user_info || data.userInfo || {};
        const accessToken = String(info.access_token || info.accessToken || '');
        const refreshToken = String(info.refresh_token || info.refreshToken || session.refreshtoken);
        if (!accessToken) throw new Error('WeChat token refresh response missing access_token');
        const credentialExpiresIn = positiveSeconds(info.expires_in || info.expiresIn);
        const credentialExpiresAt = Date.now() + credentialExpiresIn * 1000;
        const refreshTokenRotated = refreshToken !== String(session.refreshtoken || '');
        session.accesstoken = accessToken;
        session.refreshtoken = refreshToken;
        session.credentialExpiresIn = credentialExpiresIn;
        session.credentialExpiresAt = credentialExpiresAt;
        session.refreshTokenObservedAt = Date.now();

        // 旧 token 在 refresh 成功后立即失效；先让调用方落盘新 token，
        // 再发起独立的 loginBuffer 请求。后者失败也不能丢掉轮换结果。
        const checkpoint = {
            refreshtoken: refreshToken,
            accesstoken: accessToken,
            credentialExpiresAt,
            credentialExpiresIn,
            refreshTokenObservedAt: session.refreshTokenObservedAt,
            refreshTokenRotated,
        };
        if (typeof options.onCredentialsRefreshed === 'function') {
            await options.onCredentialsRefreshed(checkpoint);
        }
        if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) {
            throw new Error('微信更新准备已取消');
        }

        // 用新凭证换新 loginBuffer（凭证放 Cookie 头，服务器可能校验）
        const lbPayload = JSON.stringify({ extInfo: { listS: { unionid: { value: [session.openid] }, user_id: { value: [session.openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
        const ts2 = String(Date.now());
        const nonce2 = String(crypto.randomInt(1000, 10000));
        const sig2 = crypto.createHash('md5').update(`${lbPayload}${ts2}${LOGIN_BUFFER_ACCESS_KEY}${nonce2}`).digest('hex');
        const lifetime = { credentialExpiresAt, credentialExpiresIn, refreshTokenRotated };
        try {
            const lbResp = await request(LOGIN_BUFFER_URL, cookies, {
                method: 'POST', body: lbPayload,
                headers: {
                    'Content-Type': 'application/json',
                    'Ual-Access-Businessid': 'pc_yyb_auth',
                    'Ual-Access-Timestamp': ts2,
                    'Ual-Access-Nonce': nonce2,
                    'Ual-Access-Signature': sig2,
                    'Cookie': `openid=${session.openid}; accesstoken=${accessToken}; refreshtoken=${refreshToken}`,
                },
            });
            if (lbResp.status < 200 || lbResp.status >= 300) {
                throw new Error(`Unable to obtain WeChat login buffer (HTTP ${lbResp.status})`);
            }
            const lbData = JSON.parse(lbResp.body.toString('utf8'));
            if (lbData?.code !== 0) {
                throw credentialResponseError('login_buffer', lbData);
            }
            const loginBuffer = pickLoginBuffer(lbData);
            if (!loginBuffer) throw new Error('WeChat login buffer response is invalid');
            session.loginBuffer = loginBuffer;
            return { loginBuffer, refreshtoken: refreshToken, accesstoken: accessToken, ...checkpoint };
        } catch (error) {
            throw attachRotatedCredentials(error, refreshToken, accessToken, lifetime);
        }
    }

    destroy(session: WxLoginSession): void {
        session.cookies.clear();
        session.oauthCode = undefined;
        session.openid = undefined;
        session.nickname = undefined;
        session.loginBuffer = undefined;
        session.accesstoken = undefined;
        session.refreshtoken = undefined;
    }
}
