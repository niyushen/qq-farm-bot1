export {};
/**
 * 日志文件分割写入器
 *
 * 背景：
 * 本项目是多进程模型 —— 主进程 + 每个农场账号一个 worker 子进程（fork/thread），
 * 所有进程都往同一个 data/logs/ 目录写日志。
 * winston 内建的 maxsize/maxFiles 轮转依赖 rename + unlink，
 * 多进程并发时会出现「A 把 combined.log 改名后 B 仍在写旧 inode」、
 * 「两个进程同时 unlink 同一个文件」等竞态，导致日志丢失或文件错乱。
 *
 * 方案（无 rename，纯 append + 排他创建）：
 * 1. 按天分文件：combined-20261120.log —— 天然按时间归档，便于排查历史问题
 * 2. 单文件超限后按序号切分：combined-20261120.1.log / .2.log ...
 *    新序号文件用 'wx' 排他标志创建：若已被别的进程占用则递增序号重试，
 *    绝不覆盖他人文件
 * 3. 写入一律 append（'a' 标志），单次 write 在 O_APPEND 下对同文件是原子的，
 *    多进程并发追加不会互相截断
 *
 * 文件名带进程标识（pid），避免同一天同一账号的多进程写入同一文件时互相切分。
 */

const fs = require('node:fs');
const path = require('node:path');

export interface LogFileWriterOptions {
    /** 日志目录 */
    dir: string;
    /** 文件名前缀，如 combined / error */
    baseName: string;
    /** 单文件大小上限（字节）；超过后切分到下一个序号 */
    maxFileSize: number;
    /** 是否按天分文件 */
    dailySplit: boolean;
}

interface WriteTarget {
    /** 当前写入的文件绝对路径 */
    filePath: string;
    /** 已写入字节数（仅本进程写入的部分，用于判断是否超限） */
    written: number;
    /** 当前文件的序号 */
    index: number;
    /** 当前文件对应的日期键（YYYYMMDD），dailySplit 关闭时为固定串 */
    dayKey: string;
}

/** 取本地日期键 YYYYMMDD */
function currentDayKey(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

/**
 * 拼接分段文件名。
 * 实际写入使用带 pid 的形式（见 LogFileWriter.openTarget）：
 *   combined-20261120-12345.log / combined-20261120-12345.2.log
 * 这里保留无 pid 形式供清理器匹配旧文件名与文档说明。
 */
export function buildSegmentFileName(baseName: string, dayKey: string, index: number, dailySplit: boolean): string {
    const stem = dailySplit ? `${baseName}-${dayKey}` : baseName;
    return index > 0 ? `${stem}.${index}.log` : `${stem}.log`;
}

/**
 * 排他创建分段文件。
 * 返回实际占用的文件路径；若排他创建失败（已被其他进程占用）则返回 null。
 */
function createExclusiveFile(filePath: string): boolean {
    try {
        // 'wx'：文件已存在则抛 EEXIST，保证不会覆盖其他进程正在写的文件
        const fd = fs.openSync(filePath, 'wx');
        fs.closeSync(fd);
        return true;
    } catch {
        return false;
    }
}

/**
 * 统计目录下属于某个前缀的所有分段文件及其大小/修改时间。
 * 供清理器判断保留期与总容量。
 */
export function listSegmentFiles(dir: string, baseName: string): Array<{ filePath: string; size: number; mtimeMs: number }> {
    const out: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        // 匹配 combined.log / combined-20261120.log / combined-20261120-12345.log
        // 以及各自带序号切分的 .2.log / .2.3.log 形式
        const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escaped}(-\\d{8})?(-\\d+)?(\\.\\d+)*\\.log$`);
        if (!re.test(name)) continue;
        const filePath = path.join(dir, name);
        try {
            const st = fs.statSync(filePath);
            if (!st.isFile()) continue;
            out.push({ filePath, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
            // 文件可能刚被其他进程删除，忽略
        }
    }
    return out;
}

export class LogFileWriter {
    private readonly dir: string;
    private readonly baseName: string;
    private readonly maxFileSize: number;
    private readonly dailySplit: boolean;
    /** 每个进程写入独立文件，避免同一天同账号多进程互相切分 */
    private readonly pidSuffix: string;
    /** 写队列：保证单进程内写入顺序与大小计数准确 */
    private queue: Promise<void> = Promise.resolve();
    private target: WriteTarget | null = null;
    private closed = false;

    constructor(options: LogFileWriterOptions) {
        this.dir = options.dir;
        this.baseName = options.baseName;
        this.maxFileSize = Math.max(1, Math.floor(options.maxFileSize || 0));
        this.dailySplit = options.dailySplit !== false;
        this.pidSuffix = `${process.pid}`;
    }

    /** 当前正在写入的文件路径（供清理器保护活跃文件） */
    get activeFilePath(): string {
        return this.target ? this.target.filePath : '';
    }

    /** 写入一行（自动补换行）。异步串行，不阻塞调用方。 */
    write(line: string): void {
        if (this.closed) return;
        const text = line.endsWith('\n') ? line : `${line}\n`;
        this.queue = this.queue.then(() => this.doWrite(text)).catch(() => {
            // 写盘失败不抛出，避免影响业务；下一条日志会重新尝试打开文件
        });
    }

    /** 等待队列中所有写入完成（供测试与优雅退出使用） */
    async flush(): Promise<void> {
        await this.queue.catch(() => {});
    }

    /** 关闭写入器，释放资源 */
    async close(): Promise<void> {
        this.closed = true;
        await this.flush();
    }

    private async doWrite(text: string): Promise<void> {
        const dayKey = this.dailySplit ? currentDayKey() : 'fixed';
        const byteLength = Buffer.byteLength(text, 'utf8');

        let startIndex = 0;
        let needSwitch = false;
        if (!this.target) {
            needSwitch = true;
        } else if (this.dailySplit && this.target.dayKey !== dayKey) {
            // 跨天：新的一天从序号 0 开始
            needSwitch = true;
            startIndex = 0;
        } else if (this.target.written > 0 && this.target.written + byteLength > this.maxFileSize) {
            // 当前文件已超限：切到下一个序号
            needSwitch = true;
            startIndex = this.target.index + 1;
        }

        if (needSwitch) {
            this.target = await this.openTarget(dayKey, startIndex);
        }

        if (!this.target) return;

        await new Promise<void>((resolve) => {
            fs.appendFile(this.target!.filePath, text, 'utf8', (err) => {
                if (!err) this.target!.written += byteLength;
                resolve();
            });
        });
    }

    /**
     * 打开一个可写目标文件。
     *
     * 始终用 'wx' 排他创建：目标文件若已存在（可能是 pid 复用后上一轮运行留下的残留），
     * 则递增序号重试，绝不追加到非本次进程创建的文件 —— 否则会把不同轮次的内容混在一起。
     */
    private async openTarget(dayKey: string, startIndex: number): Promise<WriteTarget | null> {
        for (let i = 0; i < 64; i++) {
            const index = startIndex + i;
            const stem = this.dailySplit
                ? `${this.baseName}-${dayKey}-${this.pidSuffix}`
                : `${this.baseName}-${this.pidSuffix}`;
            const filePath = path.join(this.dir, index > 0 ? `${stem}.${index}.log` : `${stem}.log`);

            // 排他创建失败说明文件已存在（他人或上一轮残留），换下一个序号
            if (!createExclusiveFile(filePath)) continue;
            return { filePath, written: 0, index, dayKey };
        }
        return null;
    }
}

module.exports = {
    LogFileWriter,
    buildSegmentFileName,
    listSegmentFiles,
    currentDayKey,
};
