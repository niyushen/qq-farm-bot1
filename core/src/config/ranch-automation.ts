import { animalMap, cubMap } from './ranch-animals';

const RANCH_FEED_STAGES = ['any', 'longest', 'to_production', 'near_harvest'] as const;
export type RanchFeedStage = typeof RANCH_FEED_STAGES[number];
export const RANCH_NEAR_HARVEST_MS = 10 * 60_000;

export const RANCH_AUTOMATION_DEFAULTS = {
    ranch_harvest: true,
    ranch_produce: true,
    ranch_buy: true,
    ranch_activate_shed: true,
    ranch_upgrade: true,
    ranch_sell: true,
    // 仓鼠集市自动兑换有机化肥：会消耗松果/便便换取化肥，默认关闭由用户按需开启
    // 旧总开关仅用于兼容旧配置；运行时分别检查两种货币开关（上游 PR #162 拆分）。
    ranch_market_organic: false,
    ranch_market_organic_poop: false,
    ranch_market_organic_pinecone: false,
    ranch_grass: true,
    ranch_grass_buy: true,
    ranch_grass_threshold_percent: 20,
    // 自动填充库存罐头：会消耗罐头时长道具，默认关闭由用户按需开启
    ranch_fill_cans: false,
    // 普通罐头喂养：消耗罐头桶时长，默认关闭由用户按需开启
    ranch_feed_normal: false,
    // 普通罐头使用时机：'any' 可喂养时就用 / 'longest' 仅最长阶段 /
    // 'to_production' 加速到生产期 / 'near_harvest' 距收获 10 分钟内（上游 PR #166/#168/#177）
    ranch_feed_normal_stage: 'longest' as RanchFeedStage,
    // 有机罐头喂养：消耗有机罐头桶时长，默认关闭由用户按需开启
    ranch_feed_organic: false,
    // 有机罐头使用时机（上游 PR #177：普通与有机罐头可分别设置）
    ranch_feed_organic_stage: 'near_harvest' as RanchFeedStage,
    ranch_clean: true,
    // 自动抚摸动物：会消耗好友互动配额，默认关闭由用户按需开启
    ranch_stroke: false,
    ranch_friend_steal: true,
    ranch_friend_clean: true,
    ranch_friend_mosquito: true,
    ranch_task: true,
    ranch_illustrated: true,
    ranch_share: true,
    ranch_daily_benefit: true,
    ranch_check_minutes: 5,
    ranch_strategy: 'level' as 'level' | 'preferred' | 'bag_priority',
    ranch_bag_fallback: 'level' as 'level' | 'preferred',
    ranch_coop_animal: 0,
    ranch_shed_animal: 0,
    ranch_coop_cub_priority: [] as number[],
    ranch_shed_cub_priority: [] as number[],
};

export type RanchAutomationConfig = typeof RANCH_AUTOMATION_DEFAULTS;
export const RANCH_SWITCH_KEYS = Object.keys(RANCH_AUTOMATION_DEFAULTS).filter(key => typeof RANCH_AUTOMATION_DEFAULTS[key as keyof RanchAutomationConfig] === 'boolean');
export const RANCH_ANIMAL_OPTIONS = [...animalMap.values()].filter(animal => animal.enable_flag).map(animal => ({ value: animal.id, label: animal.name, kind: animal.husbandry_type }));

export function normalizeRanchSetting(key: string, value: unknown): boolean | number | string | number[] {
    if (key === 'ranch_feed_normal_stage' || key === 'ranch_feed_organic_stage') {
        if (typeof value !== 'string' || !RANCH_FEED_STAGES.includes(value as RanchFeedStage)) {
            throw Object.assign(new Error('请选择有效的罐头使用时机'), { code: 'INVALID_CONFIG' });
        }
        return value;
    }
    if (key === 'ranch_strategy' || key === 'ranch_bag_fallback') {
        const allowed = key === 'ranch_strategy' ? ['level', 'preferred', 'bag_priority'] : ['level', 'preferred'];
        if (!allowed.includes(String(value))) throw Object.assign(new Error('请选择有效的养殖策略'), { code: 'INVALID_CONFIG' });
        return String(value);
    }
    if (key === 'ranch_coop_animal' || key === 'ranch_shed_animal') {
        const id = Number(value);
        if (id !== 0 && !RANCH_ANIMAL_OPTIONS.some(animal => animal.value === id && animal.kind === (key === 'ranch_coop_animal' ? '窝' : '棚'))) {
            throw Object.assign(new Error('所选动物不适用于当前窝或棚'), { code: 'INVALID_CONFIG' });
        }
        return id;
    }
    if (key === 'ranch_coop_cub_priority' || key === 'ranch_shed_cub_priority') {
        const housing = key === 'ranch_coop_cub_priority' ? '窝' : '棚';
        if (!Array.isArray(value) || value.some(id => cubMap.get(id)?.husbandry_type !== housing)) {
            throw Object.assign(new Error(`${housing}的背包顺序只能包含适用于${housing}的幼崽`), { code: 'INVALID_CONFIG' });
        }
        return [...new Set<number>(value)];
    }
    if (key === 'ranch_check_minutes') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 60) {
            throw Object.assign(new Error('牧场巡查间隔必须是 1–60 的整数分钟'), { code: 'INVALID_CONFIG' });
        }
        return number;
    }
    if (key === 'ranch_grass_threshold_percent') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 100) {
            throw Object.assign(new Error('牧草补充阈值必须是 1–100 的整数百分比'), { code: 'INVALID_CONFIG' });
        }
        return number;
    }
    if (typeof value !== 'boolean') throw Object.assign(new Error('牧场开关必须为布尔值'), { code: 'INVALID_CONFIG' });
    return value;
}

export const RANCH_MARKET_SWITCH_BY_CURRENCY = {
    7002: 'ranch_market_organic_poop',
    1008: 'ranch_market_organic_pinecone',
} as const;
export const RANCH_MARKET_SWITCH_KEYS = Object.values(RANCH_MARKET_SWITCH_BY_CURRENCY);

/** 旧配置的总开关只填充缺失的新字段，已明确设置的独立开关优先。 */
export function migrateRanchMarketAutomation(input: Record<string, any>): Record<string, any> {
    const result = { ...input };
    if (typeof result.ranch_market_organic === 'boolean') {
        for (const key of RANCH_MARKET_SWITCH_KEYS) {
            if (result[key] === undefined) result[key] = result.ranch_market_organic;
        }
    }
    return result;
}

export function isRanchMarketEnabled(input: Partial<RanchAutomationConfig>): boolean {
    return RANCH_MARKET_SWITCH_KEYS.some(key => (input[key] ?? input.ranch_market_organic) === true);
}
