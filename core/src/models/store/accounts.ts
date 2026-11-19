import type { Account, AccountsData } from '../../types/account';
export {};

const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFileStrict, writeJsonFileAtomic, storageError } = require('../../services/json-db');

const { ACCOUNTS_FILE } = require('./shared-state');
let accountsCache: AccountsData | null = null;

function cloneAccounts(data: AccountsData): AccountsData {
    return { accounts: data.accounts.map(account => ({ ...account })), nextId: data.nextId };
}

function loadAccounts(): AccountsData {
    accountsCache = null;
    try {
        ensureDataDir();
        const raw = readJsonFileStrict(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
        if (!raw || !Array.isArray(raw.accounts)) throw new Error('Invalid accounts data');
        const data = normalizeAccountsData(raw);
        accountsCache = data;
        return cloneAccounts(data);
    } catch (error: any) {
        throw storageError('读取', ACCOUNTS_FILE, error);
    }
}

function saveAccounts(data: AccountsData): void {
    let normalized: AccountsData;
    try {
        ensureDataDir();
        normalized = normalizeAccountsData(data);
        writeJsonFileAtomic(ACCOUNTS_FILE, normalized);
    }
    catch (error: any) { throw storageError('保存', ACCOUNTS_FILE, error); }
    accountsCache = normalized;
}

function getAccounts(): AccountsData {
    return accountsCache ? cloneAccounts(accountsCache) : loadAccounts();
}

function normalizeAccountsData(raw: unknown): AccountsData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const accounts: Account[] = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m: number, a: any) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function normalizeAccount(raw: any): Account {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account: Account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick) account.nick = nick;
    // 账号归属（多用户体系）：优先 owner，兼容旧数据使用 username
    const owner = String(source.owner || '').trim();
    if (owner) account.owner = owner;
    else {
        const legacyOwner = String(source.username || '').trim();
        if (legacyOwner) account.owner = legacyOwner;
    }
    // 抓包登录（capture）附加字段：好友 GID / openId / 登录方式
    const gid = String(source.gid || '').trim();
    if (gid) account.gid = gid;
    const openId = String(source.openId || '').trim();
    if (openId) account.openId = openId;
    const loginType = String(source.loginType || '').trim();
    if (loginType) account.loginType = loginType;
    // 微信扫码登录附加字段：wxid + 可再生凭证（自动刷新 Code / 自动重登依赖）
    const wxid = String(source.wxid || '').trim();
    if (wxid) account.wxid = wxid;
    const loginBuffer = String(source.loginBuffer || '').trim();
    if (loginBuffer) account.loginBuffer = loginBuffer;
    const refreshtoken = String(source.refreshtoken || '').trim();
    if (refreshtoken) account.refreshtoken = refreshtoken;
    const accesstoken = String(source.accesstoken || '').trim();
    if (accesstoken) account.accesstoken = accesstoken;
    if (source.wxCredentialExpiresAt !== undefined) account.wxCredentialExpiresAt = Number(source.wxCredentialExpiresAt) || 0;
    if (source.wxCredentialExpiresIn !== undefined) account.wxCredentialExpiresIn = Number(source.wxCredentialExpiresIn) || 0;
    if (source.wxRefreshTokenObservedAt !== undefined) account.wxRefreshTokenObservedAt = Number(source.wxRefreshTokenObservedAt) || 0;
    if (source.wxCredentialLastSuccessAt !== undefined) account.wxCredentialLastSuccessAt = Number(source.wxCredentialLastSuccessAt) || 0;
    if (source.wxDefaultsApplied !== undefined) account.wxDefaultsApplied = source.wxDefaultsApplied === true;
    return account;
}

function addOrUpdateAccount(acc: Partial<Account> & { avatarUrl?: string }): AccountsData {
    const { ensureAccountConfig } = require('./account-config');
    const data = getAccounts();
    let touchedAccountId = '';
    const source: any = acc || {};
    const cleanAccount: any = {};
    for (const key of ['id', 'name', 'code', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'owner', 'gid', 'openId', 'loginType', 'wxid', 'loginBuffer', 'refreshtoken', 'accesstoken', 'wxCredentialExpiresAt', 'wxCredentialExpiresIn', 'wxRefreshTokenObservedAt', 'wxCredentialLastSuccessAt', 'wxDefaultsApplied']) {
        if (source[key] !== undefined) cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            ...(acc.owner ? { owner: String(acc.owner) } : {}),
            ...(acc.gid ? { gid: String(acc.gid) } : {}),
            ...(acc.openId ? { openId: String(acc.openId) } : {}),
            ...(acc.loginType ? { loginType: String(acc.loginType) } : {}),
            ...(acc.wxid ? { wxid: String(acc.wxid) } : {}),
            ...(acc.loginBuffer ? { loginBuffer: String(acc.loginBuffer) } : {}),
            ...(acc.refreshtoken ? { refreshtoken: String(acc.refreshtoken) } : {}),
            ...(acc.accesstoken ? { accesstoken: String(acc.accesstoken) } : {}),
            ...(acc.wxCredentialExpiresAt !== undefined ? { wxCredentialExpiresAt: Number(acc.wxCredentialExpiresAt) || 0 } : {}),
            ...(acc.wxCredentialExpiresIn !== undefined ? { wxCredentialExpiresIn: Number(acc.wxCredentialExpiresIn) || 0 } : {}),
            ...(acc.wxRefreshTokenObservedAt !== undefined ? { wxRefreshTokenObservedAt: Number(acc.wxRefreshTokenObservedAt) || 0 } : {}),
            ...(acc.wxCredentialLastSuccessAt !== undefined ? { wxCredentialLastSuccessAt: Number(acc.wxCredentialLastSuccessAt) || 0 } : {}),
            ...(acc.wxDefaultsApplied !== undefined ? { wxDefaultsApplied: acc.wxDefaultsApplied === true } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    saveAccounts(data);
    return data;
}

function deleteAccount(id: unknown): AccountsData {
    const { removeAccountConfig } = require('./account-config');
    const data = getAccounts();
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
};
