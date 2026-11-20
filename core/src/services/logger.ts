export {};
/**
 * 服务端日志服务
 *
 * 落盘策略（替代 winston 内建 File transport）：
 * - 按天分文件：data/logs/combined-YYYYMMDD-<pid>.log
 * - 单文件超过上限后按序号切分：....1.log / ....2.log
 * - 定时清理：超过保留期删除 + 目录总容量超限时按最旧优先删除
 *
 * 为什么不用 winston 内建的 maxsize/maxFiles：
 * 本项目是多进程模型（主进程 + 每账号一个 worker 子进程），所有进程写同一目录。
 * winston 的轮转依赖 rename/unlink，多进程并发时会出现竞态导致日志丢失或文件错乱。
 * 详见 core/src/services/log-file-writer.ts 顶部说明。
 *
 * 控制台输出仍由 winston Console transport 承担（保留彩色格式化），
 * 文件落盘则由自研写入器独立完成，两者互不影响。
 */

const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');
const { LOG_SYSTEM_CONFIG, LOG_FILE_SIZE_BYTES, LOG_TOTAL_SIZE_BYTES, LOG_CLEANUP_INTERVAL_MS } = require('../config/log-system');
const { LogFileWriter } = require('./log-file-writer');
const { LogCleaner } = require('./log-cleaner');

let winston: any = null;
try {
    winston = require('winston');
} catch {
    winston = null;
}

const DIAGNOSTIC_CODE_KEY_RE = /^(?:disconnect|close|error|http|status|exit|reason)Code$/i;
const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

function redactString(input: any): string {
    let text = String(input || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    return text;
}

function sanitizeMeta(value: any, depth = 0): any {
    if (depth > 4) return '[Truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => sanitizeMeta(v, depth + 1));

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (DIAGNOSTIC_CODE_KEY_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v)) {
            out[k] = v;
        } else if (SENSITIVE_KEY_RE.test(String(k))) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = sanitizeMeta(v, depth + 1);
        }
    }
    return out;
}

let fallbackLogDir: string | null = null;

function ensureFallbackLogDir(): string {
    if (fallbackLogDir) return fallbackLogDir;
    const dataDir = ensureDataDir();
    const dir = path.join(dataDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fallbackLogDir = dir;
    return fallbackLogDir;
}

/** 日志级别排序，低于当前级别的日志不落盘 */
const LEVEL_WEIGHT: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 写入器与清理器的单例（按进程维度） */
let combinedWriter: any = null;
let errorWriter: any = null;
let cleaner: any = null;

function getWriters(): { combined: any; error: any } {
    if (combinedWriter && errorWriter) return { combined: combinedWriter, error: errorWriter };
    const dir = ensureFallbackLogDir();
    const maxFileSize = LOG_FILE_SIZE_BYTES;
    const dailySplit = LOG_SYSTEM_CONFIG.dailySplitEnabled !== false;
    combinedWriter = new LogFileWriter({ dir, baseName: 'combined', maxFileSize, dailySplit });
    errorWriter = new LogFileWriter({ dir, baseName: 'error', maxFileSize, dailySplit });
    return { combined: combinedWriter, error: errorWriter };
}

/**
 * 把日志条目序列化为一行 JSON。
 * 字段顺序与旧的 winston json() 输出一致（app / level / message / module / timestamp + 平铺 meta），
 * 保证既有日志分析工具与 grep 规则继续可用。
 *
 * module 优先级：显式 meta.module 优先于模块 logger 名，
 * 与 winston child logger 的合并语义一致（child 默认 module 会被显式 meta 覆盖）。
 */
function serializeLogLine(level: string, moduleName: string, message: string, meta: any): string {
    const safeMeta = sanitizeMeta(meta || {});
    const explicitModule = safeMeta && typeof safeMeta.module === 'string' && safeMeta.module
        ? String(safeMeta.module)
        : '';
    const payload: Record<string, any> = {
        app: 'qq-farm-bot',
        level,
        message: redactString(message),
        module: explicitModule || moduleName,
    };
    for (const [k, v] of Object.entries(safeMeta)) {
        if (k === 'level' || k === 'message' || k === 'module' || k === 'timestamp' || k === 'app') continue;
        payload[k] = v;
    }
    payload.timestamp = new Date().toISOString();
    return JSON.stringify(payload);
}

/**
 * 落盘一条日志。error 级别同时写入 error.log 与 combined.log。
 */
function writeToFile(level: string, moduleName: string, message: string, meta: any): void {
    const threshold = LEVEL_WEIGHT[LOG_SYSTEM_CONFIG.level] ?? LEVEL_WEIGHT.info;
    if ((LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info) < threshold) return;

    try {
        const { combined, error } = getWriters();
        const line = serializeLogLine(level, moduleName, message, meta);
        combined.write(line);
        if (level === 'error') error.write(line);
    } catch {
        // 落盘失败不影响业务流程
    }
}

/** 启动定时清理器（每个进程启动一份，多进程并发清理已做安全处理） */
function ensureCleanerStarted(): void {
    if (cleaner) return;
    const dir = ensureFallbackLogDir();
    cleaner = new LogCleaner({
        dir,
        baseNames: ['combined', 'error'],
        retentionDays: LOG_SYSTEM_CONFIG.retentionDays,
        maxTotalSize: LOG_TOTAL_SIZE_BYTES,
        intervalMs: LOG_CLEANUP_INTERVAL_MS,
        getActiveFiles: () => {
            const writers = getWriters();
            return [writers.combined.activeFilePath, writers.error.activeFilePath].filter(Boolean);
        },
    });
    cleaner.start();
}

interface ModuleLogger {
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
}

function createConsoleFallback(moduleName: string): ModuleLogger {
    const write = (level: string, message: string, meta: any) => {
        const ts = new Date().toISOString();
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta);
        writeToFile(level, moduleName, safeMsg, safeMeta);
        if (safeMeta && Object.keys(safeMeta).length > 0) {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg} ${JSON.stringify(safeMeta)}`);
        } else {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg}`);
        }
    };
    return {
        info: (message: string, meta?: any) => write('info', message, meta),
        warn: (message: string, meta?: any) => write('warn', message, meta),
        error: (message: string, meta?: any) => write('error', message, meta),
        debug: (message: string, meta?: any) => write('debug', message, meta),
    };
}

let rootLogger: any = null;

function getRootLogger(): any {
    if (rootLogger) return rootLogger;

    if (!winston) {
        rootLogger = null;
        return rootLogger;
    }

    const level = String(LOG_SYSTEM_CONFIG.level || process.env.LOG_LEVEL || 'info').toLowerCase();
    const { combine, timestamp, errors, colorize, printf } = winston.format;

    rootLogger = winston.createLogger({
        level,
        defaultMeta: { app: 'qq-farm-bot' },
        transports: [
            new winston.transports.Console({
                format: combine(
                    colorize(),
                    timestamp(),
                    errors({ stack: true }),
                    printf((info: any) => {
                        const moduleName = info.module ? `[${info.module}] ` : '';
                        const msg = redactString(info.message || '');
                        const meta = { ...info };
                        delete meta.level;
                        delete meta.message;
                        delete meta.timestamp;
                        delete meta.app;
                        delete meta.module;
                        const safeMeta = sanitizeMeta(meta);
                        const hasMeta = safeMeta && Object.keys(safeMeta).length > 0;
                        return `${info.timestamp} [${info.level}] ${moduleName}${msg}${hasMeta ? ` ${JSON.stringify(safeMeta)}` : ''}`;
                    }),
                ),
            }),
        ],
    });

    // 文件落盘由自研写入器独立承担（按天分割 + 定时清理），见文件头说明
    ensureCleanerStarted();

    return rootLogger;
}

function createModuleLogger(moduleName = 'app'): ModuleLogger {
    const moduleTag = String(moduleName || 'app');
    const root = getRootLogger();
    if (!root) return createConsoleFallback(moduleTag);

    const child = root.child({ module: moduleTag });
    const emit = (level: string, message: string, meta: any) => {
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta);
        child[level](safeMsg, safeMeta);
        writeToFile(level, moduleTag, safeMsg, safeMeta);
    };
    return {
        info(message: string, meta = {}) {
            emit('info', message, meta);
        },
        warn(message: string, meta = {}) {
            emit('warn', message, meta);
        },
        error(message: string, meta = {}) {
            emit('error', message, meta);
        },
        debug(message: string, meta = {}) {
            emit('debug', message, meta);
        },
    };
}

/** 优雅退出前刷新写入队列（供测试与停机流程使用） */
async function flushLogs(): Promise<void> {
    if (!combinedWriter && !errorWriter) return;
    await Promise.all([
        combinedWriter ? combinedWriter.flush() : Promise.resolve(),
        errorWriter ? errorWriter.flush() : Promise.resolve(),
    ]);
}

module.exports = {
    createModuleLogger,
    sanitizeMeta,
    redactString,
    flushLogs,
};
