const assert = require('node:assert/strict');
const test = require('node:test');

const { createRuntimeState, LOG_EVENT_ALIASES } = require('../dist/runtime/runtime-state');

/**
 * 回归测试：运行日志的 event 归一化与事件筛选。
 *
 * 历史缺陷（PR #183 日志重构引入）：
 *  1. runtime-state.log() 把 extra 展开到顶层，event 落在 entry.event 而非 entry.meta.event，
 *     而前端与 filterLogs 都按 meta.event 读取 → 事件筛选/二级子模块/逐块务农聚合全部失效。
 *  2. 后端产出的 event 中英文混用（中文「农场循环」与英文 farm_cycle 并存），
 *     筛选项与日志字面不一致时精确匹配必然落空。
 *
 * 本测试固定这两条契约：
 *  - log() 产出的条目，meta.event 与顶层 event 必须一致且都存在；
 *  - filterLogs 的 event 过滤必须认 meta.event / 顶层 event，并按别名表互认中英文。
 */

function makeState() {
    const store = {
        getConfigSnapshot: () => ({}),
        getAccountConfigSnapshot: () => ({}),
        getStats: () => ({}),
    };
    return createRuntimeState({ store });
}

test('log() 把 module/event 同时写入 meta 与顶层', () => {
    const state = makeState();
    state.log('农场', '[收:1 农:15 水:8 长:23] → 收获1/种植1', {
        module: 'farm',
        event: '农场循环',
        opType: 'all',
        actions: ['收获1', '种植1'],
    });

    const pool = state.logPools.farm;
    const entry = pool[pool.length - 1];
    assert.ok(entry, '应写入农场日志池');
    // 缺陷 A 的核心断言：meta.event 必须存在（前端全部按它读）
    assert.equal(entry.meta.event, '农场循环');
    assert.equal(entry.meta.module, 'farm');
    // 顶层副本也要保留，兼容旧前端 / 日志落盘
    assert.equal(entry.event, '农场循环');
    assert.equal(entry.module, 'farm');
});

test('普通业务日志的 meta 不再是空对象', () => {
    const state = makeState();
    state.log('好友', '照顾好友', { module: 'friend', event: '照顾好友' });
    const pool = state.logPools.farm;
    const entry = pool[pool.length - 1];
    assert.deepEqual(Object.keys(entry.meta).sort(), ['event', 'module']);
});

test('系统日志的 module 仍归一化为 system', () => {
    const state = makeState();
    state.log('系统', '连接服务器');
    const pool = state.logPools.farm;
    const entry = pool[pool.length - 1];
    assert.equal(entry.meta.module, 'system');
});

test('filterLogs 按中文 event 精确命中', () => {
    const state = makeState();
    state.log('农场', '农场循环 A', { module: 'farm', event: '农场循环' });
    state.log('农场', '种植 A', { module: 'farm', event: '种植种子' });

    const hit = state.filterLogs(state.logPools.farm, { event: '农场循环' });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].msg, '农场循环 A');
});

test('filterLogs 按英文 code 能命中中文 event（缺陷 B）', () => {
    const state = makeState();
    state.log('农场', '农场循环 A', { module: 'farm', event: '农场循环' });
    state.log('农场', '种植 A', { module: 'farm', event: '种植种子' });

    const hit = state.filterLogs(state.logPools.farm, { event: 'farm_cycle' });
    assert.equal(hit.length, 1, 'farm_cycle 应命中中文「农场循环」');
    assert.equal(hit[0].msg, '农场循环 A');
});

test('filterLogs 反向：按中文也能命中英文 event', () => {
    const state = makeState();
    state.log('仓库', '出售成功', { module: 'warehouse', event: 'sell_success' });
    const hit = state.filterLogs(state.logPools.farm, { event: 'sell_success' });
    assert.equal(hit.length, 1);
});

test('filterLogs 不误伤：别名表未登记的事件不互相命中', () => {
    const state = makeState();
    state.log('农场', '常规施肥', { module: 'farm', event: '常规施肥' });
    state.log('农场', '施肥后收获作物', { module: 'farm', event: '施肥后收获作物' });

    // fertilize 不应命中「施肥后收获作物」（语义不同，单独建了别名项）
    const hit = state.filterLogs(state.logPools.farm, { event: 'fertilize' });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].event, '常规施肥');
});

test('filterLogs 对空 event 返回全部（不过滤）', () => {
    const state = makeState();
    state.log('农场', 'A', { module: 'farm', event: '农场循环' });
    state.log('农场', 'B', { module: 'farm', event: '种植种子' });
    assert.equal(state.filterLogs(state.logPools.farm, { event: '' }).length, 2);
});

test('matchesLogEvent 对无 event 的条目返回 false', () => {
    const state = makeState();
    assert.equal(state.matchesLogEvent({ msg: 'x' }, '农场循环'), false);
    assert.equal(state.matchesLogEvent({ meta: { event: '农场循环' } }, '农场循环'), true);
    assert.equal(state.matchesLogEvent({ event: '农场循环' }, 'farm_cycle'), true);
});

test('别名表本身是双向对称的', () => {
    for (const [key, aliases] of Object.entries(LOG_EVENT_ALIASES)) {
        for (const alias of aliases) {
            const back = LOG_EVENT_ALIASES[alias] || [];
            assert.ok(
                back.includes(key),
                `别名应双向：${key} -> ${alias}，但 ${alias} -> ${back.join(',')} 未回指 ${key}`,
            );
        }
    }
});

test('牧场事件按 ranch_ 前缀归入牧场空间', () => {
    const state = makeState();
    state.log('牧场', '清理好友牧场', { module: 'ranch', event: 'ranch_cleanFriend' });
    assert.equal(state.logPools.ranch.length, 1);
    assert.equal(state.logPools.farm.length, 0);
});
