const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const { PlantPhase } = require('../dist/config/config');
const { getServerTimeSec } = require('../dist/utils/utils');
const { DEFAULT_ACCOUNT_CONFIG, globalConfig } = require('../dist/models/store/shared-state');
const {
    applyConfigSnapshot,
    getAccountConfigSnapshot,
    getConfigSnapshot,
} = require('../dist/models/store/account-config');

function load(relativePath, overrides) {
    const filepath = require.resolve(relativePath);
    const localRequire = createRequire(filepath);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filepath, 'utf8'), {
        exports: module.exports, module, require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    });
    return module.exports;
}

function growingLand(id, options = {}) {
    const now = getServerTimeSec();
    return {
        id, unlocked: true, level: options.level ?? 1,
        master_land_id: options.masterId ?? 0,
        slave_land_ids: options.slaveLandIds ?? [],
        plant: {
            id: options.plantId ?? 2020002,
            left_inorc_fert_times: options.remaining ?? 1,
            phases: [
                { phase: PlantPhase.GERMINATION, begin_time: now - 100 },
                { phase: PlantPhase.MATURE, begin_time: now + 600 },
            ],
        },
    };
}

/** 构造一个 2×2 合种：主地块 1 带 3 块从属地。 */
function size2Lands() {
    return [
        growingLand(1, { slaveLandIds: [2, 3, 4] }),
        growingLand(2, { masterId: 1 }),
        growingLand(3, { masterId: 1 }),
        growingLand(4, { masterId: 1 }),
    ];
}

test('capital mode survives the save path and reaches the worker snapshot', () => {
    const accountId = '__capital_mode_roundtrip_test__';
    try {
        // 首次保存：开启资本模式
        applyConfigSnapshot(
            { capitalMode: { enabled: true, dogId: 33, leadSeconds: 60 } },
            { accountId, persist: false },
        );
        const saved = getAccountConfigSnapshot(accountId).capitalMode;
        assert.equal(saved.enabled, true);
        assert.equal(saved.dogId, 33);
        assert.equal(saved.leadSeconds, 60);

        // worker 下发用的快照必须带上 capitalMode，否则运行进程拿不到该配置
        const snapshot = getConfigSnapshot(accountId);
        assert.equal(snapshot.capitalMode.enabled, true);
        assert.equal(snapshot.capitalMode.dogId, 33);

        // worker 侧回灌快照后仍然保持开启
        const reapplied = applyConfigSnapshot(snapshot, { accountId, persist: false });
        assert.equal(reapplied.capitalMode.enabled, true);
        assert.equal(reapplied.capitalMode.dogId, 33);

        // 关闭资本模式也要能落盘
        applyConfigSnapshot(
            { capitalMode: { enabled: false, dogId: 0, leadSeconds: 10 } },
            { accountId, persist: false },
        );
        assert.equal(getAccountConfigSnapshot(accountId).capitalMode.enabled, false);
    }
    finally {
        delete globalConfig.accountConfigs[accountId];
    }
});

test('2x2 ripening switch is persisted instead of being dropped as an unknown key', () => {
    const accountId = '__fertilizer_2x2_ripen_test__';
    try {
        assert.equal(DEFAULT_ACCOUNT_CONFIG.automation.fertilizer_2x2_ripen, false);

        applyConfigSnapshot(
            { automation: { fertilizer_2x2_ripen: true, fertilizer: 'none' } },
            { accountId, persist: false },
        );
        const automation = getAccountConfigSnapshot(accountId).automation;
        assert.equal(automation.fertilizer_2x2_ripen, true);
        // 施肥策略为「不施肥」时也要保留 2x2 催熟开关
        assert.equal(automation.fertilizer, 'none');

        // 快照必须带上该键，worker 才能拿到
        const snapshot = getConfigSnapshot(accountId);
        assert.equal(snapshot.automation.fertilizer_2x2_ripen, true);

        // 关闭后也要能落盘
        applyConfigSnapshot(
            { automation: { fertilizer_2x2_ripen: false } },
            { accountId, persist: false },
        );
        assert.equal(getAccountConfigSnapshot(accountId).automation.fertilizer_2x2_ripen, false);
    }
    finally {
        delete globalConfig.accountConfigs[accountId];
    }
});

test('pickRipen2x2Lands picks the master land and excludes its slave lands', () => {
    const { pickRipen2x2Lands } = require('../dist/services/farm/land-analysis');

    // 2×2 合种：主地块 1 带 3 块从属地
    const size2 = size2Lands();
    // 普通单格作物
    const single = growingLand(5);

    const { size2LandIds, excludedIds } = pickRipen2x2Lands([...size2, single]);

    // 主地块被识别为 2x2 目标；从属地块被排除；单格作物不在目标内
    assert.ok(size2LandIds.includes(1), '主地块应是 2x2 催熟目标');
    assert.ok(!size2LandIds.includes(5), '单格作物不应是催熟目标');
    for (const id of [2, 3, 4]) {
        assert.ok(excludedIds.has(id), `从属地块 ${id} 应被排除`);
        assert.ok(!size2LandIds.includes(id), `从属地块 ${id} 不应是催熟目标`);
    }
    assert.ok(excludedIds.has(1));
});

test('2x2 ripening applies normal fertilizer then organic fertilizer even when the strategy is none', async () => {
    const calls = [];
    const { runFertilizerByConfig } = load('../dist/services/farm/planting', {
        '../../models/store': {
            getAutomation: () => ({
                fertilizer: 'none',
                fertilizer_2x2_ripen: true,
                fertilizer_land_types: ['normal'],
                fertilizer_smart_seconds: 300,
            }),
        },
        './api': {
            getAllLands: async () => ({ lands: size2Lands() }),
            fertilize: async (ids, fertilizer) => { calls.push(['normal', fertilizer, ...ids]); return ids.length; },
            fertilizeOrganicLoop: async ids => { calls.push(['organic', ...ids]); return ids.length; },
        },
        '../../utils/utils': { toNum: value => Number(value) || 0, log() {}, logWarn() {} },
        '../stats': { recordOperation() {} },
    });

    // 施肥策略为「不施肥」时，2x2 催熟仍要执行
    const result = await runFertilizerByConfig([1]);
    assert.ok(result.normal + result.organic > 0, '2x2 催熟必须实际施肥');
    assert.ok(calls.some(call => call[0] === 'normal'), '应先施普通肥');
    assert.ok(calls.some(call => call[0] === 'organic'), '再连续施有机肥');
});

test('2x2 ripening is skipped when the switch is off and the strategy is none', async () => {
    const calls = [];
    const { runFertilizerByConfig } = load('../dist/services/farm/planting', {
        '../../models/store': {
            getAutomation: () => ({
                fertilizer: 'none',
                fertilizer_2x2_ripen: false,
                fertilizer_land_types: ['normal'],
                fertilizer_smart_seconds: 300,
            }),
        },
        './api': {
            getAllLands: async () => { calls.push('read'); return { lands: size2Lands() }; },
            fertilize: async () => { calls.push('normal'); return 0; },
            fertilizeOrganicLoop: async () => { calls.push('organic'); return 0; },
        },
        '../../utils/utils': { toNum: value => Number(value) || 0, log() {}, logWarn() {} },
        '../stats': { recordOperation() {} },
    });

    const result = await runFertilizerByConfig([1]);
    assert.equal(result.normal + result.organic, 0);
    assert.ok(!calls.includes('normal') && !calls.includes('organic'), '开关关闭时不应施肥');
});
