export {};

/**
 * 日志文件写入与清理策略 —— 运行时配置
 *
 * 所有配置均可通过环境变量覆盖，未设置时使用下方默认值。
 * 命名与前缀沿用 user-system.ts 的惯例（FARM_ 前缀）。
 */

const process2 = require('node:process');

function readEnv(key: string, fallback: string = ''): string {
    const value = process2.env[key];
    return value === undefined || value === '' ? fallback : String(value);
}

function readNumber(key: string, fallback: number): number {
    const value = Number(readEnv(key, ''));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MB = 1024 * 1024;

export const LOG_SYSTEM_CONFIG = {
    /** 日志级别：debug / info / warn / error；低于该级别的日志不落盘 */
    level: readEnv('FARM_LOG_LEVEL', 'info').toLowerCase(),

    /** 单个日志文件大小上限（MB）；超过后切分为新的序号文件 */
    maxFileSizeMb: readNumber('FARM_LOG_MAX_FILE_SIZE_MB', 20),

    /** 日志保留天数；超过天数的文件在定时清理时删除 */
    retentionDays: readNumber('FARM_LOG_RETENTION_DAYS', 7),

    /** 日志目录总大小上限（MB）；超出后按最旧优先删除 */
    maxTotalSizeMb: readNumber('FARM_LOG_MAX_TOTAL_SIZE_MB', 200),

    /** 定时清理间隔（分钟） */
    cleanupIntervalMinutes: readNumber('FARM_LOG_CLEANUP_INTERVAL_MINUTES', 60),

    /** 是否启用按天分割（关闭后仅按大小切分，不按日期归档） */
    dailySplitEnabled: readEnv('FARM_LOG_DAILY_SPLIT', '1') !== '0',
};

export const LOG_FILE_SIZE_BYTES = Math.floor(LOG_SYSTEM_CONFIG.maxFileSizeMb * MB);
export const LOG_TOTAL_SIZE_BYTES = Math.floor(LOG_SYSTEM_CONFIG.maxTotalSizeMb * MB);
export const LOG_CLEANUP_INTERVAL_MS = Math.floor(LOG_SYSTEM_CONFIG.cleanupIntervalMinutes * 60 * 1000);

module.exports = {
    LOG_SYSTEM_CONFIG,
    LOG_FILE_SIZE_BYTES,
    LOG_TOTAL_SIZE_BYTES,
    LOG_CLEANUP_INTERVAL_MS,
};
