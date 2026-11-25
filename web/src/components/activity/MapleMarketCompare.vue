<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useToastStore } from '@/stores/toast'

interface ShopQuote {
  basePrice: number
  unitPrice: number
  boost: number
  complete: boolean
  tier: string | null
  remainingQuota: number
  canSell: boolean
  ownerName?: string
}

interface QuoteRow {
  gid: number
  name: string
  quote: ShopQuote | null
  failed: boolean
  reused?: boolean
}

interface Comparison {
  status: 'idle' | 'running' | 'ready' | 'failed'
  dayKey: string
  total: number
  checked: number
  reused: number
  queried: number
  partial: boolean
  updatedAt: number
  rows: QuoteRow[]
  error: string
}

type FilterKey = 'all' | 'sellable' | 'complete' | 'unboosted' | 'unavailable'
type ApiReply<T> = { ok: true, data: T } | { ok: false, error: string }

const props = defineProps<{ accountId: string, ownQuote: ShopQuote | null, stock: number, activityBusy: boolean }>()
const emit = defineEmits<{ sold: [] }>()
const toast = useToastStore()
const result = ref<Comparison | null>(null)
const loading = ref(false)
const starting = ref(false)
const selling = ref(false)
const error = ref('')
const filter = ref<FilterKey>('all')
const selected = ref<QuoteRow | null>(null)
const count = ref(1)
const captionId = useId()
const titleId = useId()
const formatter = new Intl.NumberFormat('zh-CN')
const lifecycle = new AbortController()
const path = '/api/activities/maple-market/friend-quotes'

const running = computed(() => starting.value || result.value?.status === 'running')

const ranked = computed(() => {
  if (result.value?.status !== 'ready')
    return []
  const rows = result.value.rows.slice()
  if (props.ownQuote) {
    rows.push({
      gid: 0,
      name: props.ownQuote.ownerName || '自家',
      quote: props.ownQuote,
      failed: false,
    })
  }
  return rows.sort((a, b) => (
    (b.quote?.unitPrice ?? -1) - (a.quote?.unitPrice ?? -1)
    || Number(Boolean(b.quote?.complete)) - Number(Boolean(a.quote?.complete))
    || (b.gid === 0 ? Number.MAX_SAFE_INTEGER : b.quote?.remainingQuota ?? -1) - (a.gid === 0 ? Number.MAX_SAFE_INTEGER : a.quote?.remainingQuota ?? -1)
    || a.name.localeCompare(b.name, 'zh-CN')
  ))
})

const bestOffer = computed(() => {
  const candidate = ranked.value.find(row => row.gid > 0 && row.quote?.canSell && row.quote.remainingQuota > 0)
  if (candidate?.quote && candidate.quote.unitPrice > (props.ownQuote?.unitPrice ?? 0))
    return candidate
  return null
})

const counts = computed(() => {
  const rows = result.value?.status === 'ready' ? result.value.rows : []
  const complete = rows.filter(row => row.quote?.complete).length
  const unboosted = rows.filter(row => row.quote && !row.quote.complete).length
  const unavailable = rows.filter(row => !row.quote).length
  const sellable = ranked.value.filter(row => row.quote?.canSell && (row.gid === 0 || row.quote.remainingQuota > 0)).length
  return { all: ranked.value.length, sellable, complete, unboosted, unavailable }
})

const filterOptions = computed<Array<{ key: FilterKey, label: string, count: number }>>(() => [
  { key: 'all', label: '全部', count: counts.value.all },
  { key: 'sellable', label: '可出售', count: counts.value.sellable },
  { key: 'complete', label: '已暴击', count: counts.value.complete },
  { key: 'unboosted', label: '未暴击', count: counts.value.unboosted },
  { key: 'unavailable', label: '暂无/失败', count: counts.value.unavailable },
])

const visibleRows = computed(() => {
  if (filter.value === 'all')
    return ranked.value
  if (filter.value === 'sellable')
    return ranked.value.filter(row => row.quote?.canSell && (row.gid === 0 || row.quote.remainingQuota > 0))
  if (filter.value === 'complete')
    return ranked.value.filter(row => row.gid > 0 && row.quote?.complete)
  if (filter.value === 'unboosted')
    return ranked.value.filter(row => row.gid > 0 && row.quote && !row.quote.complete)
  return ranked.value.filter(row => row.gid > 0 && !row.quote)
})

const incompleteCount = computed(() => {
  if (result.value?.status !== 'ready')
    return 0
  return result.value.rows.filter(row => !row.quote?.complete).length
})

const queryButtonText = computed(() => {
  if (running.value)
    return '正在获取报价'
  if (result.value?.status === 'ready' && result.value.total > 0)
    return incompleteCount.value > 0 ? `补查未完整（${incompleteCount.value}）` : '重新核对好友'
  return '查询全部好友'
})

const progressPercent = computed(() => {
  const total = result.value?.total || 0
  if (!total)
    return 0
  return Math.max(4, Math.min(100, Math.round((result.value!.checked / total) * 100)))
})

const statusText = computed(() => {
  const current = result.value
  if (running.value) {
    if (!current?.total)
      return '正在拉取好友名单并分批获取报价…'
    if (current.reused > 0)
      return `已查 ${current.checked} / ${current.total}（复用 ${current.reused} 位当日完整报价，补查 ${current.queried} 位）`
    return `已查 ${current.checked} / ${current.total}`
  }
  if (current?.status !== 'ready')
    return ''
  if (!current.total)
    return '暂无好友可查询'
  return [
    current.reused > 0 && `本次跳过 ${current.reused} 位当日已暴击好友`,
    current.partial && '好友列表仅返回部分数据',
  ].filter(Boolean).join(' · ')
})

const saleMax = computed(() => {
  const row = selected.value
  if (!row?.quote)
    return 0
  return row.gid === 0 ? props.stock : Math.min(props.stock, row.quote.remainingQuota)
})

const saleLimitHint = computed(() => {
  const quote = selected.value?.quote
  if (!quote || selected.value?.gid === 0 || props.stock <= quote.remainingQuota)
    return '受可卖蜜薯限制'
  return '受好友剩余额度限制'
})

function diffTone(diff: number) {
  return diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : ''
}

function formatDiff(diff: number) {
  return diff > 0 ? `+${formatter.format(diff)}` : diff < 0 ? `−${formatter.format(-diff)}` : '持平'
}

const validCount = computed(() => Number.isSafeInteger(count.value) && count.value > 0 && count.value <= saleMax.value)

function setSaleCount(value: number | null) {
  const max = Math.max(1, saleMax.value || 1)
  count.value = Math.max(1, Math.min(max, Math.floor(Number(value)) || 1))
}

async function loadComparison(start = false, preserveError = false) {
  if (loading.value || selling.value)
    return
  loading.value = true
  starting.value = start
  if (start)
    result.value = null
  if (!preserveError)
    error.value = ''
  const options = { headers: { 'x-account-id': props.accountId }, signal: lifecycle.signal, skipErrorToast: true } as any
  try {
    let response = start ? await api.post<ApiReply<Comparison>>(path, {}, options) : await api.get<ApiReply<Comparison>>(path, options)
    starting.value = false
    while (!lifecycle.signal.aborted) {
      const { data } = response
      if (!data.ok)
        throw new Error(data.error)
      result.value = data.data
      if (data.data.status !== 'running')
        break
      await new Promise(resolve => setTimeout(resolve, 650))
      if (lifecycle.signal.aborted)
        return
      response = await api.get<ApiReply<Comparison>>(path, options)
    }
  }
  catch (cause) {
    if (!lifecycle.signal.aborted)
      error.value = getApiErrorMessage(cause, '读取好友报价失败')
  }
  finally {
    loading.value = false
    starting.value = false
  }
}

function select(row: QuoteRow) {
  count.value = 1
  selected.value = row
  error.value = ''
}

function closeSale() {
  if (!selling.value)
    selected.value = null
}

async function sell() {
  const row = selected.value
  if (!row?.quote?.canSell || !validCount.value || selling.value || props.activityBusy)
    return
  const quote = row.quote
  selling.value = true
  error.value = ''
  const options = { headers: { 'x-account-id': props.accountId }, skipErrorToast: true } as any
  try {
    if (row.gid === 0) {
      const { data } = await api.post<ApiReply<{ sold: number, income: number }>>('/api/activities/maple-market/sell', {
        count: count.value,
        expectedUnitPrice: quote.unitPrice,
      }, options)
      if (lifecycle.signal.aborted)
        return
      if (!data.ok)
        throw new Error(data.error)
      toast.success(`已卖出 ${data.data.sold} 个蜜薯，获得 ${formatter.format(data.data.income)} 福气币`)
      emit('sold')
    }
    else {
      const { data } = await api.post<ApiReply<{ sold: number, income: number, remainingQuota: number }>>(`${path}/sell`, {
        gid: row.gid,
        count: count.value,
        expectedUnitPrice: quote.unitPrice,
      }, options)
      if (lifecycle.signal.aborted)
        return
      if (!data.ok)
        throw new Error(data.error)
      quote.remainingQuota = data.data.remainingQuota
      toast.success(`已卖出 ${data.data.sold} 个蜜薯，获得 ${formatter.format(data.data.income)} 福气币`)
      emit('sold')
    }
  }
  catch (cause) {
    if (!lifecycle.signal.aborted) {
      error.value = getApiErrorMessage(cause, '出售失败，已同步最新报价')
      selected.value = null
      selling.value = false
      await loadComparison(false, true)
      emit('sold')
    }
  }
  finally {
    selected.value = null
    selling.value = false
  }
}

onMounted(() => void loadComparison())
onUnmounted(() => lifecycle.abort())
</script>

<template>
  <section class="maple-compare" :aria-labelledby="titleId">
    <header class="maple-card maple-compare__bar">
      <div class="maple-compare__bar-top">
        <div class="maple-compare__intro">
          <h3 :id="titleId">
            好友铺子比价
          </h3>
          <p>按暴击后的实际收购价排序。同一天再查会跳过已暴击的好友，只补查其余好友。</p>
        </div>
        <NButton type="primary" :loading="running" :disabled="loading || !!selected" @click="loadComparison(true)">
          <template #icon>
            <span class="i-carbon-search" />
          </template>
          {{ queryButtonText }}
        </NButton>
      </div>

      <div v-if="running" class="maple-compare__progress">
        <div
          class="maple-track"
          role="progressbar"
          aria-label="好友报价查询进度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="progressPercent"
        >
          <span :style="{ width: `${progressPercent}%` }" />
        </div>
        <p role="status">
          {{ statusText }}
        </p>
      </div>

      <div v-else-if="result?.status === 'ready' && result.total > 0" class="maple-compare__summary">
        <div v-if="bestOffer?.quote && ownQuote" class="maple-compare__banner">
          <span class="i-carbon-trophy" aria-hidden="true" />
          <span>
            推荐卖到 <strong>{{ bestOffer.name }}</strong>：<b>{{ formatter.format(bestOffer.quote.unitPrice) }}</b> 福气币/个（比自家高 +{{ formatter.format(bestOffer.quote.unitPrice - ownQuote.unitPrice) }}）
          </span>
        </div>
        <div v-else-if="ownQuote" class="maple-compare__banner is-self">
          <span class="i-carbon-store" aria-hidden="true" />
          <span>当前自家收购价最高（<b>{{ formatter.format(ownQuote.unitPrice) }}</b> 福气币/个）</span>
        </div>
        <span v-if="statusText" class="maple-compare__meta">{{ statusText }}</span>
      </div>
    </header>

    <p v-if="error || result?.error" role="alert" class="maple-compare__error">
      <span class="i-carbon-warning-alt" aria-hidden="true" />{{ error || result?.error }}
    </p>

    <EmptyState
      v-if="!running && (!result || result.status === 'idle')"
      title="还没有查询好友报价"
      description="点击右上角「查询全部好友」，后台会分批读取好友小铺；未暴击的好友也能直接出售"
      icon="i-carbon-chart-bar"
    />

    <EmptyState
      v-else-if="!running && result?.status === 'ready' && result.total === 0"
      title="暂无好友可查询"
      icon="i-carbon-user-multiple"
    />

    <template v-else-if="result?.status === 'ready' && result.total > 0">
      <div class="maple-picks" role="group" aria-label="好友报价筛选">
        <button
          v-for="item in filterOptions"
          :key="item.key"
          type="button"
          class="maple-pick"
          :class="{ 'is-selected': filter === item.key }"
          :aria-pressed="filter === item.key"
          @click="filter = item.key"
        >
          {{ item.label }} <small>{{ item.count }}</small>
        </button>
      </div>

      <section class="maple-card maple-compare__board">
        <div class="maple-compare__hscroll custom-scrollbar">
          <div class="maple-grid" role="table" :aria-labelledby="captionId">
            <span :id="captionId" class="sr-only">好友铺子实际收购价排行</span>
            <div class="maple-grid__head" role="rowgroup">
              <div class="maple-grid__row" role="row">
                <span role="columnheader" class="is-center">#</span>
                <span role="columnheader" class="is-start">铺主</span>
                <span role="columnheader" aria-sort="descending">收购价</span>
                <span role="columnheader">比自家</span>
                <span role="columnheader">剩余额度</span>
                <span role="columnheader">操作</span>
              </div>
            </div>
            <div class="maple-grid__body custom-scrollbar" role="rowgroup" tabindex="0" aria-label="好友报价列表">
              <div
                v-for="(row, index) in visibleRows"
                :key="row.gid"
                class="maple-grid__row"
                :class="{ 'is-featured': row.gid === bestOffer?.gid, 'is-self': row.gid === 0 }"
                role="row"
              >
                <span role="cell" class="is-center">
                  <span class="maple-rank" :class="{ 'is-top': row.quote && index < 3 }">{{ index + 1 }}</span>
                </span>
                <span role="rowheader" class="is-start">
                  <span class="maple-owner">
                    <strong>{{ row.name }}</strong>
                    <span v-if="row.gid === 0" class="maple-chip">我</span>
                    <span v-else-if="row.gid === bestOffer?.gid" class="maple-chip is-best">最高</span>
                  </span>
                </span>
                <template v-if="row.quote">
                  <span role="cell" class="maple-compare__price">
                    <strong>{{ formatter.format(row.quote.unitPrice) }}</strong>
                    <small v-if="row.quote.boost > 0">{{ formatter.format(row.quote.basePrice) }} + <em>{{ formatter.format(row.quote.boost) }}</em></small>
                    <small v-else-if="row.failed" class="is-danger">复查失败</small>
                    <small v-else>未暴击</small>
                  </span>
                  <span role="cell">
                    <span v-if="row.gid === 0 || !ownQuote" class="maple-diff">—</span>
                    <span v-else class="maple-diff" :class="diffTone(row.quote.unitPrice - ownQuote.unitPrice)">
                      {{ formatDiff(row.quote.unitPrice - ownQuote.unitPrice) }}
                    </span>
                  </span>
                  <span role="cell" class="maple-quota">
                    {{ row.gid === 0 ? '不限' : formatter.format(row.quote.remainingQuota) }}
                  </span>
                  <span role="cell">
                    <NButton
                      v-if="row.quote.canSell && (row.gid === 0 || row.quote.remainingQuota > 0)"
                      :type="row.gid === bestOffer?.gid ? 'primary' : 'default'"
                      :secondary="row.gid !== bestOffer?.gid"
                      size="small"
                      :aria-label="`卖这里，${row.name}`"
                      :disabled="stock <= 0 || activityBusy || selling"
                      @click="select(row)"
                    >
                      卖这里
                    </NButton>
                    <span v-else class="maple-chip is-muted">
                      {{ row.gid > 0 && row.quote.remainingQuota <= 0 ? '额度已满' : '暂不可售' }}
                    </span>
                  </span>
                </template>
                <span v-else role="cell" class="maple-grid__span">
                  <span class="maple-chip" :class="row.failed ? 'is-danger' : 'is-muted'">
                    {{ row.failed ? '查询失败' : '暂无报价' }}
                  </span>
                </span>
              </div>
              <p v-if="!visibleRows.length" class="maple-compare__empty-filter">
                当前筛选条件下没有好友
              </p>
            </div>
          </div>
        </div>
      </section>
    </template>

    <NModal :show="!!selected" :mask-closable="!selling" :close-on-esc="!selling" @update:show="visible => !visible && closeSale()">
      <NCard
        class="maple-confirm"
        :title="selected?.gid === 0 ? '出售给自家小铺' : `出售给 · ${selected?.name || '好友'}`"
        :bordered="false"
        :closable="!selling"
        role="dialog"
        aria-modal="true"
        @close="closeSale"
      >
        <div v-if="selected?.quote" class="maple-confirm__body">
          <dl class="maple-ledger-mini">
            <div>
              <dt>收购单价</dt>
              <dd>
                {{ formatter.format(selected.quote.unitPrice) }} 福气币 / 个
                <small v-if="selected.quote.boost > 0">{{ formatter.format(selected.quote.basePrice) }} + 暴击 {{ formatter.format(selected.quote.boost) }}</small>
              </dd>
            </div>
            <div>
              <dt>最多可卖</dt>
              <dd>
                {{ formatter.format(saleMax) }} 个
                <small>{{ saleLimitHint }}</small>
              </dd>
            </div>
          </dl>
          <div class="maple-quantity">
            <NInputNumber
              :value="count"
              :min="1"
              :max="Math.max(1, saleMax)"
              :disabled="selling"
              button-placement="both"
              aria-label="出售数量"
              @update:value="setSaleCount"
            />
            <NButton secondary :disabled="selling || saleMax <= 0 || count >= saleMax" @click="setSaleCount(saleMax)">
              全部
            </NButton>
          </div>
          <div class="maple-estimate">
            <span>{{ formatter.format(count) }} × {{ formatter.format(selected.quote.unitPrice) }}</span>
            <strong>{{ formatter.format(validCount ? count * selected.quote.unitPrice : 0) }} <small>福气币</small></strong>
          </div>
        </div>
        <template #footer>
          <div class="maple-confirm__actions">
            <NButton :disabled="selling" @click="closeSale">
              取消
            </NButton>
            <NButton type="primary" :loading="selling" :disabled="!validCount || selling || activityBusy" @click="sell">
              卖出 {{ formatter.format(count) }} 个
            </NButton>
          </div>
        </template>
      </NCard>
    </NModal>
  </section>
</template>

<style scoped>
.maple-compare {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

.maple-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.maple-compare__bar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}

.maple-compare__bar-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
}

.maple-compare__intro h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
}

.maple-compare__intro p {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.maple-compare__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.maple-compare__progress p {
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.maple-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ui-primary);
  transition: width var(--spring-drag-duration) var(--spring-drag);
}

.maple-compare__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
}

.maple-compare__banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.maple-compare__banner.is-self {
  color: var(--ui-ink);
  background: var(--ui-surface-soft);
}

.maple-compare__meta {
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-compare__error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 14px;
  border-radius: 12px;
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.maple-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.maple-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.maple-pick:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
}

.maple-pick.is-selected {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-weight: var(--fw-600);
}

.maple-pick small {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.maple-compare__board {
  overflow: hidden;
}

/* 窄屏横向滚动时表头和列表一起移动；纵向只滚动列表，表头保持在滚动区外。 */
.maple-compare__hscroll {
  overflow-x: auto;
  overflow-y: hidden;
}

.maple-grid {
  --maple-cols: 48px minmax(120px, 1fr) repeat(3, 96px) 92px;
  min-inline-size: 560px;
  font-variant-numeric: tabular-nums;
}

.maple-grid__head,
.maple-grid__body {
  scrollbar-gutter: stable;
}

.maple-grid__head {
  overflow: hidden;
  border-bottom: 1px solid var(--ui-border);
}

.maple-grid__body {
  overflow-y: auto;
  max-block-size: min(32rem, 60vh);
}

.maple-grid__body:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.maple-grid__row {
  display: grid;
  grid-template-columns: var(--maple-cols);
  align-items: center;
}

.maple-grid__row > * {
  min-width: 0;
  padding: 11px 14px;
  text-align: end;
}

.maple-grid__head .maple-grid__row > * {
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
  white-space: nowrap;
}

.maple-grid__body .maple-grid__row + .maple-grid__row {
  border-top: 1px solid var(--ui-border);
}

.maple-grid__row > .is-start {
  text-align: start;
}

.maple-grid__row > .is-center {
  padding-inline: 4px;
  text-align: center;
}

.maple-grid__span {
  grid-column: 3 / -1;
}

.maple-grid__body .maple-grid__row.is-featured {
  background: color-mix(in srgb, var(--ui-primary-soft) 55%, transparent);
}

.maple-grid__body .maple-grid__row.is-self {
  background: color-mix(in srgb, var(--ui-surface-soft) 65%, transparent);
}

@media (min-width: 900px) {
  .maple-grid {
    --maple-cols: 56px minmax(160px, 1fr) repeat(3, 120px) 108px;
  }
}

.maple-rank {
  display: inline-grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.maple-rank.is-top {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.maple-owner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.maple-owner strong {
  color: var(--ui-ink);
  white-space: nowrap;
  font-size: 14px;
  font-weight: var(--fw-600);
}

.maple-compare__price {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.maple-compare__price strong {
  color: var(--ui-ink);
  font-size: 16px;
  font-weight: var(--fw-700);
}

.maple-compare__price small {
  color: var(--ui-subtle);
  font-size: 11px;
}

.maple-compare__price small em {
  color: var(--ui-warning);
  font-style: normal;
  font-weight: var(--fw-600);
}

.maple-compare__price small.is-danger {
  color: var(--ui-danger);
}

.maple-diff {
  color: var(--ui-subtle);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.maple-diff.is-up {
  color: var(--ui-primary);
}

.maple-diff.is-down {
  color: var(--ui-danger);
}

.maple-quota {
  color: var(--ui-ink);
  font-size: 13px;
}

.maple-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  font-weight: var(--fw-600);
  white-space: nowrap;
}

.maple-chip.is-best {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.maple-chip.is-muted {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-weight: var(--fw-400);
}

.maple-chip.is-danger {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.maple-compare__empty-filter {
  margin: 0;
  padding: 28px 16px;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

/* —— 弹窗 —— */
.maple-confirm {
  display: flex;
  width: min(440px, calc(100vw - 32px));
  max-height: min(88dvh, 900px);
  flex-direction: column;
  overflow: hidden;
}

.maple-confirm :deep(.n-card-header),
.maple-confirm :deep(.n-card__footer) {
  flex: none;
}

.maple-confirm__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.maple-ledger-mini {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.maple-ledger-mini > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.maple-ledger-mini dt {
  color: var(--ui-muted);
}

.maple-ledger-mini dd {
  margin: 0;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.maple-ledger-mini small {
  display: block;
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
}

.maple-quantity {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.maple-quantity :deep(.n-input__input-el) {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.maple-estimate {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  color: var(--ui-muted);
  background: var(--ui-primary-soft);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.maple-estimate strong {
  color: var(--ui-primary);
  font-size: 20px;
  font-weight: var(--fw-700);
}

.maple-estimate small {
  font-size: 12px;
  font-weight: var(--fw-500);
}

.maple-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 540px) {
  .maple-compare__bar {
    padding: 14px 16px;
  }

  .maple-grid__row > * {
    padding: 10px;
  }

  .maple-confirm__actions > :deep(.n-button) {
    flex: 1;
  }
}
</style>
