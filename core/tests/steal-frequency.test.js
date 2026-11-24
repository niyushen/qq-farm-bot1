const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    STEAL_FREQUENCY_TIERS,
    STEAL_FREQUENCY_CALIBRATION_MS,
    DEFAULT_STEAL_FREQUENCY_TIER,
    getStealCalibrationMs,
    normalizeStealFrequencyTier,
} = require('../dist/config/steal-frequency');

const {
    DEFAULT_ACCOUNT_CONFIG,
    globalConfig,
} = require('../dist/models/store/shared-state');
const {
    applyConfigSnapshot,
    getAccountConfigSnapshot,
    getConfigSnapshot,
} = require('../dist/models/store/account-config');

test('三档定义齐全且周期递增', () => {
    assert.deepEqual([...STEAL_FREQUENCY_TIERS], ['relaxed', 'standard', 'eager']);
    assert.equal(STEAL_FREQUENCY_CALIBRATION_MS.relaxed, 15 * 60 * 1000);
    assert.equal(STEAL_FREQUENCY_CALIBRATION_MS.standard, 8 * 60 * 1000);
    assert.equal(STEAL_FREQUENCY_CALIBRATION_MS.eager, 3 * 60 * 1000);
    // 勤快档周期必须最短，否则「勤快」名不副实
    assert.ok(STEAL_FREQUENCY_CALIBRATION_MS.eager < STEAL_FREQUENCY_CALIBRATION_MS.standard);
    assert.ok(STEAL_FREQUENCY_CALIBRATION_MS.standard < STEAL_FREQUENCY_CALIBRATION_MS.relaxed);
});

test('默认档位是 standard，对应 8 分钟校准周期', () => {
    assert.equal(DEFAULT_STEAL_FREQUENCY_TIER, 'standard');
    assert.equal(DEFAULT_ACCOUNT_CONFIG.stealFrequencyTier, 'standard');
    assert.equal(getStealCalibrationMs(DEFAULT_STEAL_FREQUENCY_TIER), 8 * 60 * 1000);
});

test('非法档位回落到默认档，不得返回 0 或负数', () => {
    // 周期为 0 会让校准变成死循环，持续拉好友列表。
    for (const bad of ['', '  ', null, undefined, 'fast', 0, {}, []]) {
        const tier = normalizeStealFrequencyTier(bad);
        assert.equal(tier, 'standard', `bad=${JSON.stringify(bad)}`);
        assert.equal(getStealCalibrationMs(bad), 8 * 60 * 1000, `bad=${JSON.stringify(bad)}`);
    }
    // 大小写与首尾空白要宽容处理（手改 JSON / 表单粘贴都可能带上）
    assert.equal(normalizeStealFrequencyTier('EAGER'), 'eager');
    assert.equal(normalizeStealFrequencyTier('  relaxed  '), 'relaxed');
});

test('偷菜频率档位走配置保存往返并能落盘', () => {
    const accountId = '__steal_frequency_roundtrip_test__';
    try {
        applyConfigSnapshot({ stealFrequencyTier: 'eager' }, { accountId, persist: false });
        assert.equal(getAccountConfigSnapshot(accountId).stealFrequencyTier, 'eager');
        assert.equal(getConfigSnapshot(accountId).stealFrequencyTier, 'eager');

        applyConfigSnapshot({ stealFrequencyTier: 'relaxed' }, { accountId, persist: false });
        assert.equal(getAccountConfigSnapshot(accountId).stealFrequencyTier, 'relaxed');

        // 非法值必须被服务端夹回默认档，不能原样存进去
        applyConfigSnapshot({ stealFrequencyTier: 'turbo' }, { accountId, persist: false });
        assert.equal(getAccountConfigSnapshot(accountId).stealFrequencyTier, 'standard');
    } finally {
        delete globalConfig.accountConfigs[accountId];
    }
});

test('调度器按配置档位取校准周期，不再写死 15 分钟', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/friend/scheduler.ts'), 'utf8');
    // 硬编码常量必须移除，否则改档不会生效
    assert.doesNotMatch(src, /const STEAL_CALIBRATION_INTERVAL_MS/, '校准周期不得再硬编码');
    // 判定必须实时读配置，切换档位才能立即生效
    assert.match(src, /getStealCalibrationMs\(getStealFrequencyTier\(\)\)/,
        '校准周期必须实时读取账号配置的档位');
});

test('core 与 web 的档位值一一对应', () => {
    const webSrc = fs.readFileSync(path.resolve(__dirname, '../../web/src/utils/steal-frequency.ts'), 'utf8');
    for (const tier of STEAL_FREQUENCY_TIERS) {
        assert.match(webSrc, new RegExp(`'${tier}'`), `web 缺少档位 ${tier}`);
    }
    // 默认档位两边必须一致
    assert.match(webSrc, /DEFAULT_STEAL_FREQUENCY_TIER: StealFrequencyTier = 'standard'/);
});

test('core 与 web 的档位分钟数必须一致，防止面板显示与实际生效不符', () => {
    const webSrc = fs.readFileSync(path.resolve(__dirname, '../../web/src/utils/steal-frequency.ts'), 'utf8');
    for (const tier of STEAL_FREQUENCY_TIERS) {
        const coreMinutes = STEAL_FREQUENCY_CALIBRATION_MS[tier] / 60 / 1000;
        // web 侧按 value + label + minutes 的顺序书写，逐档取出 minutes 后与 core 比对。
        const pattern = new RegExp(`value:\\s*'${tier}'[\\s\\S]{0,120}?minutes:\\s*(\\d+)`);
        const matched = webSrc.match(pattern);
        assert.ok(matched, `web 缺少档位 ${tier} 的 minutes`);
        assert.equal(Number(matched[1]), coreMinutes,
            `档位 ${tier} 两边不一致：web=${matched[1]} 分钟，core=${coreMinutes} 分钟`);
    }
});
