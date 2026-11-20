export {};
/**
 * 日志文件定时清理器
 *
 * 两条独立的清理规则：
 * 1. 保留期：修改时间超过 N 天的日志文件直接删除
 * 2. 总容量：日志目录总大小超过上限时，按最旧优先删除，直到回到上限以内
 *
 * 安全约束：
 * - 正在写入的活跃文件永不删除（由写入器提供 activeFilePath）
 * - 多进程场景下多个进程可能同时判定同一文件应删除，
 *   删除失败（ENOENT）视为他人已删，静默忽略即可
 * - 定时器 unref，不阻止进程退出
 */

const fs = require('node:fs');
const path = require('node:path');
const { listSegmentFiles } = require('./log-file-writer');

export interface LogCleanerOptions {
    /** 日志目录 */
    dir: string;
    /** 需要纳入统计与清理的文件名前缀列表 */
    baseNames: string[];
    /** 保留天数；文件修改时间超过该值即删除 */
    retentionDays: number;
    /** 目录总大小上限（字节） */
    maxTotalSize: number;
    /** 清理间隔（毫秒） */
    intervalMs: number;
    /** 返回当前活跃文件路径数组，用于保护不被删除 */
    getActiveFiles?: () => string[];
}

export interface LogCleanResult {
    /** 本次删除的文件数 */
    removed: number;
    /** 本次释放的字节数 */
    freedBytes: number;
    /** 清理后目录占用字节数 */
    remainingBytes: number;
    /** 清理后剩余文件数 */
    remainingFiles: number;
}

export class LogCleaner {
    private readonly options: LogCleanerOptions;
    private timer: any = null;
    private running = false;

    constructor(options: LogCleanerOptions) {
        this.options = options;
    }

    /** 启动定时清理 */
    start(): void {
        if (this.timer) return;
        const interval = Math.max(60 * 1000, this.options.intervalMs || 60 * 60 * 1000);
        this.timer = setInterval(() => {
            void this.runOnce();
        }, interval);
        // unref：定时器不阻止进程退出
        if (typeof this.timer.unref === 'function') this.timer.unref();
        // 启动时先跑一次，清理上次运行残留的过期文件
        void this.runOnce();
    }

    /** 停止定时清理 */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** 执行一次清理 */
    async runOnce(): Promise<LogCleanResult> {
        if (this.running) {
            return { removed: 0, freedBytes: 0, remainingBytes: 0, remainingFiles: 0 };
        }
        this.running = true;
        try {
            return this.clean();
        } finally {
            this.running = false;
        }
    }

    private clean(): LogCleanResult {
        const { dir, baseNames, retentionDays, maxTotalSize } = this.options;
        const activeFiles = new Set(
            (typeof this.options.getActiveFiles === 'function' ? this.options.getActiveFiles() : []).map(p => path.resolve(p)),
        );

        // 汇总所有纳入管理的文件
        let all: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
        for (const baseName of baseNames) {
            all = all.concat(listSegmentFiles(dir, baseName));
        }

        const now = Date.now();
        const retentionMs = Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
        const removedPaths = new Set<string>();
        let freedBytes = 0;

        // 规则 1：超过保留期
        for (const file of all) {
            if (activeFiles.has(path.resolve(file.filePath))) continue;
            if (retentionMs <= 0) continue;
            if (now - file.mtimeMs <= retentionMs) continue;
            if (this.removeFile(file.filePath)) {
                removedPaths.add(path.resolve(file.filePath));
                freedBytes += file.size;
            }
        }

        // 规则 2：总容量超限，按最旧优先删除
        const remain = all.filter(f => !removedPaths.has(path.resolve(f.filePath)));
        let totalBytes = remain.reduce((sum, f) => sum + f.size, 0);
        if (totalBytes > maxTotalSize) {
            const sorted = remain.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const file of sorted) {
                if (totalBytes <= maxTotalSize) break;
                if (activeFiles.has(path.resolve(file.filePath))) continue;
                if (this.removeFile(file.filePath)) {
                    totalBytes -= file.size;
                    freedBytes += file.size;
                    removedPaths.add(path.resolve(file.filePath));
                }
            }
        }

        const remainingFiles = all.length - removedPaths.size;
        return {
            removed: removedPaths.size,
            freedBytes,
            remainingBytes: totalBytes,
            remainingFiles,
        };
    }

    /** 删除文件；文件已被其他进程删除时静默返回 false */
    private removeFile(filePath: string): boolean {
        try {
            fs.unlinkSync(filePath);
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = {
    LogCleaner,
};
