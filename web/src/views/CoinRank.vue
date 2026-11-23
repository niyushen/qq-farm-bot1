<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import RollingNumber from '@/components/ui/RollingNumber.vue'

interface RankItem {
  id: string
  name: string
  nick: string
  avatar: string
  platform?: string
  running: boolean
  todayGoldEarned: number
  gold: number
  rank: number
}

interface RankData {
  date: string
  updatedAt: number
  totalGoldGained: number
  /** 参与汇总的全员账号数 */
  accountCount?: number
  /** 榜单展示条数 */
  limit?: number
  list: RankItem[]
}

const loading = ref(false)
const data = ref<RankData | null>(null)
const failedAvatars = ref<Set<string>>(new Set())

const medal = {
  1: { label: '冠军', color: '#E3B23C', soft: 'rgba(227, 178, 60, 0.14)', chip: '#F7CE5B', ink: '#6d4e00', icon: 'i-carbon-trophy-filled' },
  2: { label: '亚军', color: '#AEB9C4', soft: 'rgba(174, 185, 196, 0.16)', chip: '#D5DEE6', ink: '#44505c', icon: 'i-carbon-star-filled' },
  3: { label: '季军', color: '#C98256', soft: 'rgba(201, 130, 86, 0.14)', chip: '#E6A876', ink: '#7a3f18', icon: 'i-carbon-star-filled' },
} as const

const topThree = computed(() => (data.value?.list || []).filter(item => item.rank <= 3))
const restList = computed(() => (data.value?.list || []).filter(item => item.rank > 3))

/** 全员总增加：所有账号今日金币增加量之和（不受榜单仅展示前十影响） */
const totalGain = computed(() => Number(data.value?.totalGoldGained || 0))

/** 领奖台视觉顺序：亚军(2) - 冠军(1) - 季军(3) */
const podiumOrder = computed(() => {
  const map = new Map(topThree.value.map(item => [item.rank, item]))
  return [map.get(2), map.get(1), map.get(3)].filter(Boolean) as RankItem[]
})

function formatNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num).toLocaleString('zh-CN') : '0'
}

function medalOf(rank: number) {
  return medal[rank as 1 | 2 | 3] || medal[3]
}

function avatarFailed(id: string) {
  return failedAvatars.value.has(id)
}

function markAvatarFailed(id: string) {
  const next = new Set(failedAvatars.value)
  next.add(id)
  failedAvatars.value = next
}

function resolveAvatar(item: RankItem) {
  return item.avatar && !avatarFailed(item.id) ? item.avatar : ''
}

async function loadRank(silent = false) {
  if (!silent)
    loading.value = true
  try {
    const res = await api.get('/api/coin-rank', { skipErrorToast: true } as any)
    if (res.data?.ok && res.data?.data) {
      data.value = res.data.data as RankData
    }
  }
  catch {
    // 静默失败：保留上一次成功的榜单数据
  }
  finally {
    loading.value = false
  }
}

onMounted(() => loadRank())

// 金币增量实时变化，每 30 秒静默刷新一次榜单
useIntervalFn(() => loadRank(true), 30000)
</script>

<template>
  <div class="page-stack space-y-4">
    <!-- 概览条 -->
    <div class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div class="flex flex-col gap-4 p-4 sm:p-5">
        <!-- 全员总增加：主视觉区 -->
        <div class="rank-total">
          <div class="rank-total__head">
            <span class="rank-total__icon">
              <span class="i-carbon-trophy" />
            </span>
            <span class="rank-total__label">全员今日金币总增加</span>
          </div>
          <div class="rank-total__value">
            <RollingNumber
              :value="totalGain"
              :sign="true"
              :group="true"
              :duration="1100"
              class="rank-total__number"
            />
            <span class="rank-total__unit">金币</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading && !data" class="flex items-center justify-center gap-2 farm-card py-16 text-gray-400">
      <span class="i-svg-spinners-270-ring text-xl" />
      <span>正在加载排行榜…</span>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading && (!data || !data.list.length)" class="flex flex-col items-center justify-center gap-2 farm-card py-16 text-gray-400">
      <span class="i-carbon-trophy text-4xl" />
      <p class="text-sm">
        暂无排行榜数据，添加并启动农场账号后即可查看
      </p>
    </div>

    <template v-else>
      <!-- 前三名领奖台 -->
      <div v-if="podiumOrder.length" class="podium-grid">
        <div
          v-for="item in podiumOrder"
          :key="item.id"
          class="podium-card"
          :class="`podium-card--rank-${item.rank}`"
          :style="{ '--medal': medalOf(item.rank).color, '--medal-soft': medalOf(item.rank).soft, '--medal-chip': medalOf(item.rank).chip, '--medal-ink': medalOf(item.rank).ink }"
        >
          <div class="podium-card__glow" />
          <div class="relative z-1 flex flex-col items-center">
            <div class="podium-crown" :style="{ color: medalOf(item.rank).color }">
              <span :class="medalOf(item.rank).icon" />
            </div>
            <div class="podium-card__label" :style="{ color: medalOf(item.rank).color }">
              {{ medalOf(item.rank).label }}
            </div>
            <div class="podium-avatar">
              <img
                v-if="resolveAvatar(item)"
                :src="resolveAvatar(item)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="markAvatarFailed(item.id)"
              >
              <span v-else class="i-carbon-user-avatar text-3xl text-gray-300 dark:text-gray-600" />
              <span class="podium-rank-badge" :style="{ background: medalOf(item.rank).chip, color: medalOf(item.rank).ink }">
                {{ item.rank }}
              </span>
            </div>
            <div class="mt-3 max-w-full truncate text-sm text-gray-800 font-semibold dark:text-gray-100" :title="item.name">
              {{ item.name }}
            </div>
            <div v-if="item.nick && item.nick !== item.name" class="mt-0.5 max-w-full truncate text-xs text-gray-400 dark:text-gray-500" :title="item.nick">
              {{ item.nick }}
            </div>
            <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              今日增加
            </div>
            <div class="podium-gain" :style="{ color: medalOf(item.rank).color }">
              <RollingNumber
                :value="item.todayGoldEarned"
                :sign="true"
                :group="true"
                :duration="900"
              />
            </div>
            <div class="mt-1 flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
              <span class="i-carbon-currency-dollar" />
              当前 {{ formatNumber(item.gold) }}
            </div>
          </div>
        </div>
      </div>

      <!-- 第 4 名起列表 -->
      <div v-if="restList.length" class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white shadow-md dark:border-gray-700 dark:bg-gray-800">
        <div class="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-700/40">
          <div class="flex items-center gap-2">
            <span class="i-carbon-list text-lg text-gray-500 dark:text-gray-400" />
            <h3 class="text-sm text-gray-700 font-semibold dark:text-gray-300">
              其他排名
            </h3>
            <span class="text-xs text-gray-400">第 4 名起</span>
          </div>
        </div>
        <div class="divide-y divide-gray-100 dark:divide-gray-700/60">
          <div
            v-for="item in restList"
            :key="item.id"
            class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50 sm:px-5 dark:hover:bg-gray-700/30"
          >
            <div class="w-7 shrink-0 text-center text-sm text-gray-400 tabular-nums font-semibold dark:text-gray-500">
              {{ item.rank }}
            </div>
            <div class="h-10 w-10 shrink-0 overflow-hidden border border-gray-200 rounded-full bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
              <img
                v-if="resolveAvatar(item)"
                :src="resolveAvatar(item)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="markAvatarFailed(item.id)"
              >
              <span v-else class="i-carbon-user-avatar h-full w-full flex items-center justify-center text-xl text-gray-300 dark:text-gray-500" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-100" :title="item.name">
                {{ item.name }}
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <span v-if="item.nick && item.nick !== item.name" class="truncate" :title="item.nick">{{ item.nick }}</span>
                <span v-if="item.running" class="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                  <span class="h-1.5 w-1.5 rounded-full bg-green-500" />运行中
                </span>
              </div>
            </div>
            <div class="shrink-0 text-right">
              <div class="text-sm text-amber-600 tabular-nums font-bold dark:text-amber-400">
                <RollingNumber
                  :value="item.todayGoldEarned"
                  :sign="true"
                  :group="true"
                  :duration="800"
                />
              </div>
              <div class="text-[11px] text-gray-400">
                今日增加
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 全员总增加主视觉区 */
.rank-total {
  position: relative;
  overflow: hidden;
  padding: 18px 20px 20px;
  border-radius: 16px;
  background:
    radial-gradient(120% 90% at 0% 0%, rgba(240, 192, 64, 0.22), transparent 62%),
    radial-gradient(100% 80% at 100% 100%, rgba(67, 141, 99, 0.14), transparent 60%), var(--ui-surface-soft);
  border: 1px solid rgba(227, 178, 60, 0.28);
}

.rank-total__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rank-total__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: linear-gradient(135deg, #f0c040, #e3b23c);
  color: #fff;
  font-size: 13px;
  box-shadow: 0 2px 6px rgba(227, 178, 60, 0.35);
}

.rank-total__label {
  font-size: 13px;
  font-weight: var(--fw-600);
  color: var(--ui-muted);
  letter-spacing: 0.02em;
}

.rank-total__value {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
}

.rank-total__number {
  font-size: clamp(34px, 7vw, 52px);
  font-weight: var(--fw-800);
  line-height: 1.05;
  color: #d99413;
  letter-spacing: -0.01em;
  text-shadow: 0 2px 10px rgba(217, 148, 19, 0.22);
}

.rank-total__unit {
  font-size: 14px;
  font-weight: var(--fw-600);
  color: var(--ui-subtle);
}

.rank-total__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.rank-total__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: var(--fw-600);
  color: var(--ui-muted);
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
}

.rank-total__chip--muted {
  color: var(--ui-subtle);
}

.dark .rank-total {
  border-color: rgba(227, 178, 60, 0.22);
  background:
    radial-gradient(120% 90% at 0% 0%, rgba(240, 192, 64, 0.16), transparent 62%),
    radial-gradient(100% 80% at 100% 100%, rgba(67, 141, 99, 0.12), transparent 60%), rgba(31, 41, 55, 0.55);
}

.dark .rank-total__number {
  color: #f2c558;
  text-shadow: 0 2px 12px rgba(242, 197, 88, 0.25);
}

.podium-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: 12px;
}

.podium-card {
  position: relative;
  overflow: hidden;
  min-width: 0;
  padding: 18px 12px 20px;
  border: 2px solid var(--medal);
  border-radius: 18px;
  background: var(--ui-surface);
  box-shadow:
    var(--ui-shadow-sm),
    0 0 0 4px var(--medal-soft);
  text-align: center;
}

.podium-card__glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 80% at 50% 0%, var(--medal-soft), transparent 70%);
  pointer-events: none;
}

.podium-card--rank-1 {
  padding-top: 28px;
  padding-bottom: 28px;
  box-shadow:
    var(--ui-shadow-md),
    0 0 0 5px var(--medal-soft);
}

.podium-crown {
  font-size: 28px;
  line-height: 1;
}

.podium-card--rank-1 .podium-crown {
  font-size: 34px;
}

.podium-card__label {
  margin-top: 4px;
  font-size: 13px;
  font-weight: var(--fw-700);
}

.podium-avatar {
  position: relative;
  width: 64px;
  height: 64px;
  margin: 12px auto 0;
  overflow: visible;
  border-radius: 9999px;
  background: var(--ui-bg-soft);
  display: flex;
  align-items: center;
  justify-content: center;
}

.podium-card--rank-1 .podium-avatar {
  width: 76px;
  height: 76px;
}

.podium-avatar img {
  border-radius: 9999px;
  border: 3px solid var(--medal);
}

.podium-rank-badge {
  position: absolute;
  right: -4px;
  bottom: -2px;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  border: 2px solid var(--ui-surface-solid);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: var(--fw-800);
}

.podium-gain {
  margin-top: 2px;
  font-size: 20px;
  font-weight: var(--fw-800);
  font-variant-numeric: tabular-nums;
}

.podium-card--rank-1 .podium-gain {
  font-size: 24px;
}

@media (max-width: 480px) {
  .podium-grid {
    gap: 8px;
  }

  .podium-card {
    padding: 14px 6px 16px;
    border-radius: 14px;
  }

  .podium-card--rank-1 {
    padding-top: 20px;
    padding-bottom: 20px;
  }

  .podium-crown {
    font-size: 22px;
  }

  .podium-card--rank-1 .podium-crown {
    font-size: 26px;
  }

  .podium-avatar {
    width: 48px;
    height: 48px;
  }

  .podium-card--rank-1 .podium-avatar {
    width: 58px;
    height: 58px;
  }

  .podium-gain {
    font-size: 15px;
  }

  .podium-card--rank-1 .podium-gain {
    font-size: 17px;
  }
}
</style>
