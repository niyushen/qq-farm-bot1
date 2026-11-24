export {};

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getDataDir } = require('../../config/runtime-paths');
const { writeJsonFileAtomic } = require('../json-db');

/**
 * 牧场动作的当日计数。
 *
 * 牧场的动作全部走 operate()，这里只做「按天 + 按动作名」的累加，
 * 供牧场概览的「今日统计」展示。跨天自动归零，不做跨重启对齐 ——
 * 计数只是给人看的运营数据，不是结算依据。
 */

interface CurrencyDay {
    /** 当天首次观测到的余额：今日增减以此为基准。 */
    baseline: number;
    current: number;
}

interface DailyStats {
    date: string;
    actions: Record<string, number>;
    /** 金券 1007 / 松果 1008 / 便便 7002 的当日基线与最新余额。 */
    currencies?: Record<string, CurrencyDay>;
}

function accountId(): string {
    const id = process.env.FARM_ACCOUNT_ID;
    return id ? String(id) : '';
}

function dateKey(at = Date.now()): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fileFor(id: string): string {
    const dir = path.join(getDataDir(), 'ranch-stats');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${createHash('sha256').update(id).digest('hex')}.json`);
}

function read(id: string): DailyStats {
    const empty: DailyStats = { date: dateKey(), actions: {}, currencies: {} };
    if (!id) return empty;
    try {
        const data = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
        if (!data || typeof data !== 'object' || data.date !== dateKey() || typeof data.actions !== 'object')
            return empty;
        return {
            date: data.date,
            actions: { ...data.actions },
            currencies: data.currencies && typeof data.currencies === 'object' ? { ...data.currencies } : {},
        };
    }
    catch {
        return empty;
    }
}

/** 记录一次成功执行的牧场动作。 */
function recordAction(action: string): void {
    const id = accountId();
    if (!id || !action) return;
    const data = read(id);
    data.actions[action] = (Number(data.actions[action]) || 0) + 1;
    try {
        writeJsonFileAtomic(fileFor(id), data);
    }
    catch {
        // 统计失败不影响主流程
    }
}

/** 内存里的最近一次余额指纹：没变就不写盘，避免每次拉快照都磨盘。 */
let lastCurrencyFingerprint = '';

/**
 * 记录资源余额（金券 1007 / 松果 1008 / 便便 7002）：
 * 当天第一次观测作为基线，之后每次快照更新最新值；
 * 概览页的「今日统计」用 current - baseline 展示今日增减。
 */
function recordCurrencies(balances: Record<string, number>): void {
    const id = accountId();
    if (!id) return;
    const entries = Object.entries(balances)
        .map(([key, value]) => [String(key), Number(value) || 0] as const)
        .filter(([, value]) => Number.isFinite(value));
    if (!entries.length) return;
    const fingerprint = entries.map(([key, value]) => `${key}:${value}`).join('|');
    if (fingerprint === lastCurrencyFingerprint) return;
    const data = read(id);
    data.currencies = data.currencies || {};
    for (const [key, value] of entries) {
        const day = data.currencies[key] || { baseline: value, current: value };
        day.current = value;
        data.currencies[key] = day;
    }
    try {
        writeJsonFileAtomic(fileFor(id), data);
        lastCurrencyFingerprint = fingerprint;
    }
    catch {
        // 统计失败不影响主流程
    }
}

/** 今日统计快照：{ date, actions, currencies }，当天没有记录时都是空对象。 */
function getToday(): DailyStats {
    return read(accountId());
}

module.exports = { recordAction, recordCurrencies, getToday };
