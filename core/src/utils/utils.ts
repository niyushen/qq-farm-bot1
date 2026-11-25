/**
 * 通用工具函数
 */
import type Long from 'long';
export {};

const LongModule = require('long');
const { CONFIG } = require('../config/config');
const { createModuleLogger, sanitizeMeta } = require('../services/logger');
const coreLogger = createModuleLogger('core');

// ============ 服务器时间状态 ============
let serverTimeOffsetMs = 0;
const dateFormatters: Map<string, Intl.DateTimeFormat> = new Map();
const timeFormatters: Map<string, Intl.DateTimeFormat> = new Map();

// ============ 类型转换 ============
function toLong(val: number | Long): Long {
    return LongModule.fromNumber(val as number);
}

function toNum(val: Long | number | null | undefined): number {
    if (LongModule.isLong(val)) return (val as Long).toNumber();
    return (val as number) || 0;
}

// ============ 时间相关 ============

/** 获取当前推算的服务器时间(秒) */
function getServerTimeSec(): number {
    return Math.floor((Date.now() + serverTimeOffsetMs) / 1000);
}

function serverTimeToLocalMs(timestampMs: number): number {
    return timestampMs - serverTimeOffsetMs;
}

/** 同步服务器时间 */
function syncServerTime(ms: number): void {
    serverTimeOffsetMs = ms ? ms - Date.now() : 0;
}

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = dateFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        dateFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = timeFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        timeFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function partsToRecord(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== 'literal') result[part.type] = part.value;
    }
    return result;
}

/** 按指定 IANA 时区生成日期键，不依赖服务器操作系统时区 */
function formatDateKeyInTimeZone(nowMs: number, timeZone: string): string {
    const parts = partsToRecord(getDateFormatter(timeZone).formatToParts(new Date(nowMs)));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 获取系统配置时区下的当前日期键 */
function getSystemDateKey(nowMs: number = getServerTimeSec() * 1000): string {
    return formatDateKeyInTimeZone(nowMs, CONFIG.timeZone);
}

/** 获取系统配置时区下的当前分钟数（0-1439） */
function getSystemClockMinutes(nowMs: number = getServerTimeSec() * 1000): number {
    const parts = partsToRecord(getTimeFormatter(CONFIG.timeZone).formatToParts(new Date(nowMs)));
    return Number(parts.hour) * 60 + Number(parts.minute);
}

/** 按系统配置时区格式化日志时间 */
function formatSystemDateTime24(nowMs: number = Date.now()): string {
    const date = formatDateKeyInTimeZone(nowMs, CONFIG.timeZone);
    const parts = partsToRecord(getTimeFormatter(CONFIG.timeZone).formatToParts(new Date(nowMs)));
    return `${date} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * 将时间戳归一化为秒级
 * 大于 1e12 认为是毫秒级，转换为秒级
 */
function toTimeSec(val: Long | number | null | undefined): number {
    const n = toNum(val);
    if (n <= 0) return 0;
    if (n > 1e12) return Math.floor(n / 1000);
    return n;
}

// ============ 日志 ============
type LogHook = (tag: string, msg: string, isWarn: boolean, meta: Record<string, any>) => void;
let logHook: LogHook | null = null;
function setLogHook(hook: LogHook): void { logHook = hook; }

function normalizeMeta(meta: any): Record<string, any> {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
    return sanitizeMeta(meta);
}

function resolveModuleTag(moduleName: string): string {
    const moduleMap: Record<string, string> = {
        farm: '农场',
        ranch: '牧场',
        friend: '好友',
        warehouse: '仓库',
        task: '任务',
        system: '系统',
    };
    const m = String(moduleName || '').trim();
    return moduleMap[m] || '系统';
}

function inferModuleFromTag(tag: string): string {
    const t = String(tag || '').trim();
    const tagMap: Record<string, string> = {
        农场: 'farm',
        牧场: 'ranch',
        商店: 'warehouse',
        购买: 'warehouse',
        仓库: 'warehouse',
        好友: 'friend',
        任务: 'task',
        活跃: 'task',
        系统: 'system',
        错误: 'system',
        WS: 'system',
        心跳: 'system',
        推送: 'system',
    };
    return tagMap[t] || 'system';
}

// ============ 日志空间（牧场 / 农场） ============
const LOG_SPACE_RANCH = 'ranch';
const LOG_SPACE_FARM = 'farm';

/** 归一化外部传入的空间标识；空串 / 非法值表示「不限定空间」（两池合并） */
function normalizeLogSpace(value: unknown): string {
    const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (raw === LOG_SPACE_RANCH || raw === LOG_SPACE_FARM) return raw;
    return '';
}

/**
 * 判定日志条目所属空间。
 * 与前端 web/src/utils/log-space.ts 的 resolveEntrySpace 保持完全一致的判定顺序：
 * module=ranch → event 以 ranch_ 开头 → tag=牧场，三者命中其一即为牧场，其余全部归农场。
 */
function resolveLogSpace(entry: any): string {
    const meta = (entry && entry.meta) || {};
    if (String(meta.module || '') === LOG_SPACE_RANCH) return LOG_SPACE_RANCH;
    if (String(meta.event || '').startsWith('ranch_')) return LOG_SPACE_RANCH;
    if (String((entry && entry.tag) || '') === '牧场') return LOG_SPACE_RANCH;
    return LOG_SPACE_FARM;
}

interface NormalizedLogArgs {
    tag: string;
    msg: string;
    meta: any;
}

function normalizeLogArgs(arg1: string, arg2: string | object | null, arg3?: any): NormalizedLogArgs {
    // 新写法: log(msg, meta)
    if (typeof arg2 !== 'string') {
        return {
            tag: '',
            msg: String(arg1 || ''),
            meta: arg2 || null,
        };
    }
    // 兼容旧写法: log(tag, msg, meta)
    return {
        tag: String(arg1 || ''),
        msg: String(arg2 || ''),
        meta: arg3 || null,
    };
}

function log(arg1: string, arg2: string | object | null, arg3: any = null): void {
    const { tag, msg, meta } = normalizeLogArgs(arg1, arg2, arg3);
    const safeMeta = normalizeMeta(meta);
    if (!safeMeta.module) safeMeta.module = inferModuleFromTag(tag);
    const displayTag = resolveModuleTag(safeMeta.module);
    coreLogger.info(msg, { tag: displayTag, ...safeMeta });
    if (logHook) {
        try { logHook(displayTag, msg, false, safeMeta); } catch {}
    }
}

function logWarn(arg1: string, arg2: string | object | null, arg3: any = null): void {
    const { tag, msg, meta } = normalizeLogArgs(arg1, arg2, arg3);
    const safeMeta = normalizeMeta(meta);
    if (!safeMeta.module) safeMeta.module = inferModuleFromTag(tag);
    const displayTag = resolveModuleTag(safeMeta.module);
    coreLogger.warn(msg, { tag: displayTag, ...safeMeta });
    if (logHook) {
        try { logHook(displayTag, msg, true, safeMeta); } catch {}
    }
}

// ============ 异步工具 ============
function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
    const min = Math.max(0, Math.floor(minMs) || 0);
    const max = Math.max(min, Math.floor(maxMs) || min);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    return new Promise(r => setTimeout(r, delay));
}

module.exports = {
    toLong, toNum,
    setLogHook,
    getServerTimeSec, serverTimeToLocalMs, syncServerTime, getSystemDateKey, getSystemClockMinutes,
    formatDateKeyInTimeZone, formatSystemDateTime24, toTimeSec,
    log, logWarn, sleep, randomDelay,
    LOG_SPACE_RANCH, LOG_SPACE_FARM, normalizeLogSpace, resolveLogSpace,
};
