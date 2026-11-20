const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LogFileWriter, listSegmentFiles, buildSegmentFileName } = require('../dist/services/log-file-writer');
const { LogCleaner } = require('../dist/services/log-cleaner');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-log-'));
}

function listLogFiles(dir) {
    return fs.readdirSync(dir).filter(name => name.endsWith('.log')).sort();
}

test('LogFileWriter 按天分文件写入', async () => {
    const dir = makeTempDir();
    const writer = new LogFileWriter({ dir, baseName: 'combined', maxFileSize: 1024 * 1024, dailySplit: true });
    writer.write('{"level":"info","message":"第一行"}');
    writer.write('{"level":"info","message":"第二行"}');
    await writer.flush();

    const files = listLogFiles(dir);
    assert.equal(files.length, 1);
    // 文件名应包含日期键与 pid
    assert.match(files[0], /^combined-\d{8}-\d+\.log$/);

    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).message, '第一行');
    assert.equal(JSON.parse(lines[1]).message, '第二行');
    assert.equal(writer.activeFilePath, path.join(dir, files[0]));

    await writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogFileWriter 超过大小上限后按序号切分', async () => {
    const dir = makeTempDir();
    // 上限设小，强制切分
    const writer = new LogFileWriter({ dir, baseName: 'combined', maxFileSize: 200, dailySplit: true });
    for (let i = 0; i < 20; i++) {
        writer.write(`{"level":"info","message":"第${i}行"}`);
    }
    await writer.flush();

    const files = listLogFiles(dir);
    assert.ok(files.length > 1, `期望产生多个分段文件，实际 ${files.length}`);

    // 每个文件都不应超过上限太多（最后一行可能略微超出）
    for (const name of files) {
        const size = fs.statSync(path.join(dir, name)).size;
        assert.ok(size <= 200 + 100, `文件 ${name} 大小 ${size} 明显超出上限`);
    }

    // 所有分段的行数总和应等于写入行数
    let total = 0;
    for (const name of files) {
        const content = fs.readFileSync(path.join(dir, name), 'utf8');
        total += content.trim() ? content.trim().split('\n').length : 0;
    }
    assert.equal(total, 20);

    await writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogFileWriter 不会覆盖已存在的文件', async () => {
    const dir = makeTempDir();
    // 预置一个同名文件（模拟其他进程已占用）
    const dayKey = new Date();
    const y = dayKey.getFullYear();
    const m = String(dayKey.getMonth() + 1).padStart(2, '0');
    const d = String(dayKey.getDate()).padStart(2, '0');
    const occupied = path.join(dir, `combined-${y}${m}${d}-${process.pid}.log`);
    fs.writeFileSync(occupied, '{"existing":"占用"}\n', 'utf8');

    const writer = new LogFileWriter({ dir, baseName: 'combined', maxFileSize: 1024 * 1024, dailySplit: true });
    writer.write('{"level":"info","message":"新内容"}');
    await writer.flush();

    // 原文件内容未被破坏（写入器应切到新的序号文件）
    const original = fs.readFileSync(occupied, 'utf8');
    assert.match(original, /占用/);
    assert.doesNotMatch(original, /新内容/);

    // 新内容写到了别的文件
    const files = listLogFiles(dir);
    assert.ok(files.length >= 2, '应产生新的分段文件而非写入已占用文件');
    const allContent = files.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    assert.match(allContent, /新内容/);

    await writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogFileWriter 关闭后不再接受写入', async () => {
    const dir = makeTempDir();
    const writer = new LogFileWriter({ dir, baseName: 'combined', maxFileSize: 1024 * 1024, dailySplit: true });
    writer.write('{"message":"关闭前"}');
    await writer.close();
    writer.write('{"message":"关闭后"}');
    await writer.flush();

    const files = listLogFiles(dir);
    const content = files.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    assert.match(content, /关闭前/);
    assert.doesNotMatch(content, /关闭后/);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogFileWriter 关闭按天分割时文件名固定', async () => {
    const dir = makeTempDir();
    const writer = new LogFileWriter({ dir, baseName: 'combined', maxFileSize: 1024 * 1024, dailySplit: false });
    writer.write('{"message":"不按天分"}');
    await writer.flush();

    const files = listLogFiles(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^combined-\d+\.log$/);

    await writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('listSegmentFiles 识别各类分段文件名', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'combined-20261120-123.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'combined-20261120-123.2.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'combined.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'error-20261120-123.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'other-20261120.log'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8');

    const combined = listSegmentFiles(dir, 'combined');
    const names = combined.map(f => path.basename(f.filePath)).sort();
    assert.deepEqual(names, ['combined-20261120-123.2.log', 'combined-20261120-123.log', 'combined.log']);

    const error = listSegmentFiles(dir, 'error');
    assert.equal(error.length, 1);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('buildSegmentFileName 生成预期文件名', () => {
    assert.equal(buildSegmentFileName('combined', '20261120', 0, true), 'combined-20261120.log');
    assert.equal(buildSegmentFileName('combined', '20261120', 3, true), 'combined-20261120.3.log');
    assert.equal(buildSegmentFileName('combined', '20261120', 0, false), 'combined.log');
});

test('LogCleaner 删除超过保留期的文件', async () => {
    const dir = makeTempDir();
    const oldFile = path.join(dir, 'combined-20260101-1.log');
    const newFile = path.join(dir, 'combined-20261120-1.log');
    fs.writeFileSync(oldFile, 'old', 'utf8');
    fs.writeFileSync(newFile, 'new', 'utf8');

    // 把旧文件的修改时间设为 10 天前
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    const cleaner = new LogCleaner({
        dir,
        baseNames: ['combined'],
        retentionDays: 7,
        maxTotalSize: 1024 * 1024,
        intervalMs: 60 * 1000,
    });
    const result = await cleaner.runOnce();

    assert.equal(result.removed, 1);
    assert.ok(!fs.existsSync(oldFile), '过期文件应被删除');
    assert.ok(fs.existsSync(newFile), '未过期文件应保留');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogCleaner 超过总容量时按最旧优先删除', async () => {
    const dir = makeTempDir();
    const files = [];
    for (let i = 1; i <= 4; i++) {
        const p = path.join(dir, `combined-2026112${i}-1.log`);
        fs.writeFileSync(p, 'x'.repeat(1000), 'utf8');
        files.push(p);
    }
    // 文件 1 最旧，文件 4 最新
    const now = Date.now();
    files.forEach((p, idx) => {
        const t = new Date(now - (4 - idx) * 60 * 60 * 1000);
        fs.utimesSync(p, t, t);
    });

    const cleaner = new LogCleaner({
        dir,
        baseNames: ['combined'],
        retentionDays: 30,
        maxTotalSize: 2500,
        intervalMs: 60 * 1000,
    });
    const result = await cleaner.runOnce();

    // 4000 字节 > 2500 上限，至少删掉 2 个（共 4000，删 2 个后剩 2000）
    assert.ok(result.removed >= 2, `期望至少删除 2 个文件，实际 ${result.removed}`);
    // 最旧的应优先被删
    assert.ok(!fs.existsSync(files[0]), '最旧的文件应优先被删除');
    // 最新的应保留
    assert.ok(fs.existsSync(files[3]), '最新的文件应被保留');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogCleaner 不会删除正在写入的活跃文件', async () => {
    const dir = makeTempDir();
    const activeFile = path.join(dir, 'combined-20261120-1.log');
    fs.writeFileSync(activeFile, 'x'.repeat(5000), 'utf8');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(activeFile, tenDaysAgo, tenDaysAgo);

    const cleaner = new LogCleaner({
        dir,
        baseNames: ['combined'],
        retentionDays: 7,
        maxTotalSize: 100,
        intervalMs: 60 * 1000,
        getActiveFiles: () => [activeFile],
    });
    const result = await cleaner.runOnce();

    assert.equal(result.removed, 0);
    assert.ok(fs.existsSync(activeFile), '活跃文件不应被删除');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('LogCleaner 目录不存在时安全返回', async () => {
    const cleaner = new LogCleaner({
        dir: path.join(os.tmpdir(), 'qqfarm-not-exist-dir-xyz'),
        baseNames: ['combined'],
        retentionDays: 7,
        maxTotalSize: 1024,
        intervalMs: 60 * 1000,
    });
    const result = await cleaner.runOnce();
    assert.equal(result.removed, 0);
    assert.equal(result.remainingFiles, 0);
});

test('logger 落盘格式与旧版兼容（app/level/message/module/timestamp + 平铺 meta）', async () => {
    const dataDir = makeTempDir();
    const prevDataDir = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dataDir;

    // 清理模块缓存，确保读到新的 FARM_DATA_DIR
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}services${path.sep}logger`)) delete require.cache[key];
    }

    const { createModuleLogger, flushLogs } = require('../dist/services/logger');
    const logger = createModuleLogger('runtime');
    logger.info('测试消息', { tag: '系统', module: 'farm', event: 'unit_test', count: 3 });
    await flushLogs();

    const logDir = path.join(dataDir, 'logs');
    const files = fs.readdirSync(logDir).filter(n => n.startsWith('combined'));
    assert.ok(files.length > 0, '应生成 combined 日志文件');

    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
    const entry = JSON.parse(content.trim().split('\n')[0]);
    assert.equal(entry.app, 'qq-farm-bot');
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, '测试消息');
    assert.equal(entry.module, 'farm', '显式 meta.module 应优先于模块 logger 名');
    assert.equal(entry.event, 'unit_test', 'meta 应平铺到顶层');
    assert.equal(entry.count, 3);
    assert.ok(entry.timestamp, '应包含 timestamp');

    if (prevDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
});
