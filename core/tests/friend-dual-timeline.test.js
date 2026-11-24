const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const src = (file) => readFileSync(join(__dirname, '..', 'src', file), 'utf8');
const worker = src('core/worker.ts');
const friendScheduler = src('services/friend/scheduler.ts');
const visitStrategy = src('services/friend/visit-strategy.ts');
const friendIndex = src('services/friend/index.ts');

function bodyOf(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    assert.ok(start > 0, `找不到 ${startMarker}`);
    return text.slice(start, text.indexOf(endMarker, start));
}

// 帮助与偷菜是两条独立到期线：帮助固定 10 分钟，偷菜由成熟时刻驱动。
test('worker 拆分帮助线与偷菜线，帮助固定 10 分钟', () => {
    assert.match(worker, /const HELP_TICK_INTERVAL_MS = 10 \* 60 \* 1000/);
    const help = bodyOf(worker, 'async function runFriendTick', '// ============ 偷菜 Tick');
    assert.match(help, /checkFriends\(\{ onlyHelp: true \}\)/, '帮助线只做帮忙');
    assert.match(help, /checkFriends\(\{ onlyBad: true \}\)/, '捣乱走帮助线');
    assert.doesNotMatch(help, /await checkFriends\(\)/, '帮助线不得再全量巡查（会与偷菜线重复偷）');
    assert.match(help, /nextFriendRunAt = Date\.now\(\) \+ helpMs/);
});

test('偷菜 Tick 消费成熟计划延迟，并保留 15 分钟保底与 1 秒下限', () => {
    const steal = bodyOf(worker, 'async function runStealTick', 'async function runUnifiedTick');
    assert.match(steal, /nextStealDelayMs = await runScheduledStealCheck\(\)/);
    assert.match(steal, /nextStealRunAt = Date\.now\(\) \+ Math\.max\(1000, Number\(nextStealDelayMs\) \|\| 15 \* 60 \* 1000\)/);
    assert.match(steal, /if \(stealTaskRunning\) return/);
    // 外层不能套自动化锁，否则与 checkFriends 内部 detached 访问死锁
    assert.doesNotMatch(steal, /runExclusiveAutomationTask/);
});

test('统一 tick 与排期纳入偷菜到期点，且保留 B 独有的牧场线与防重守卫', () => {
    const tick = bodyOf(worker, 'async function runUnifiedTick', 'function scheduleUnifiedNextTick');
    assert.match(tick, /const dueSteal = now >= nextStealRunAt/);
    assert.match(tick, /if \(dueSteal && !stealTaskRunning\) void runStealTick/);
    assert.match(tick, /runRanchRoutine\(true\)/, 'B 独有的牧场例程必须保留');
    const schedule = bodyOf(worker, 'function scheduleUnifiedNextTick', 'function startUnifiedScheduler');
    assert.match(schedule, /stealTaskRunning \? Number\.POSITIVE_INFINITY/);
    assert.match(schedule, /ranchNextRunAt\(\)/, 'B 独有的牧场排期必须保留');
    assert.match(schedule, /if \(unifiedTickGeneration === runtimeGeneration\) return/, 'B 独有防重守卫不得删除');
});

test('停机清全部三个运行标记，漏清偷菜会导致重启后永久停摆', () => {
    const stop = bodyOf(worker, 'function stopUnifiedScheduler', 'function stopMysteryShopTimer');
    for (const field of ['farmTaskRunning', 'friendTaskRunning', 'stealTaskRunning', 'nextStealDelayMs']) {
        assert.match(stop, new RegExp(`${field} = (false|0)`), `${field} 未在停机时复位`);
    }
});

test('配置下发保留偷菜成熟时刻，首次启动才重置', () => {
    assert.match(worker, /function resetUnifiedSchedule\(options: \{ preserveSteal\?: boolean \} = \{\}\)/);
    assert.match(worker, /if \(!options\.preserveSteal\) nextStealRunAt = now \+ randomIntervalMs\(5000, 15000\)/);
    const start = bodyOf(worker, 'function startUnifiedScheduler', 'function stopUnifiedScheduler');
    assert.match(start, /resetUnifiedSchedule\(\);/, '首次启动仍全量重置');
    // 配置保存路径必须使用 preserveSteal
    const config = bodyOf(worker, 'function applyRuntimeConfig', '// 接收主进程指令');
    assert.match(config, /resetUnifiedSchedule\(\{ preserveSteal: true \}\)/);
    assert.doesNotMatch(config, /\n\s*resetUnifiedSchedule\(\);/, '配置下发不得打回随机窗口');
});

test('nextChecks 两条倒计时独立，不再共用好友读数', () => {
    const nextChecks = bodyOf(worker, 'fullStats.nextChecks = {', 'fullStats.automation');
    assert.match(nextChecks, /两条独立到期时间线/);
    assert.match(nextChecks, /helpRemainSec: friendRemainSec/);
    assert.match(nextChecks, /stealRemainSec,/);
    assert.doesNotMatch(nextChecks, /stealRemainSec: friendRemainSec/);
});

test('成熟观测写入点齐备：好友摘要、进农场精确墙钟、拉黑清理、到期归位', () => {
    assert.match(friendScheduler, /observeFriendSummary\(friend\)/);
    assert.match(friendScheduler, /claimDueFriends\(\)/, 'checkFriends 收尾需归位到期计划');
    assert.match(visitStrategy, /observeFriendLands\(gid, lands, \{ name \}\)/);
    const run = bodyOf(friendScheduler, 'export async function runScheduledStealCheck', '// ============ 循环控制');
    assert.match(run, /dropFriendMaturityPlans\(blacklist\)/);
    assert.match(run, /claimDueFriends\(\{ limit: 12 \}\)/);
    assert.match(run, /if \(isCheckingFriends\) return getNextStealDelayMs\(\)/, '被帮助占用时按成熟计划重唤醒，不能写死 60 秒');
    // B 独有：网关退避异常必须上抛
    assert.match(run, /isGatewayYieldError\(e\)/);
});

test('成熟计划模块由 friend/index 导出，供 worker 与 scheduler 消费', () => {
    assert.match(friendIndex, /} from '\.\/maturity-plan'/);
    assert.match(friendIndex, /runScheduledStealCheck/);
});
