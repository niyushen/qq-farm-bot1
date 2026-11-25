<script setup lang="ts">
import type { MallGoodsDto } from '@/stores/commerce'
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ActivityRulesDialog from '@/components/activity/ActivityRulesDialog.vue'
import MapleMarketCompare from '@/components/activity/MapleMarketCompare.vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import PurchaseDialog from '@/components/commerce/PurchaseDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

interface MarketGoodsItem {
  id: number
  count: number
  name: string
  image: string
}

interface MarketGoods {
  id: number
  name: string
  items: MarketGoodsItem[]
  price: number
  limitType: number
  limitTimes: number | null
  remaining: number | null
  exchangeable: boolean
}

interface MarketState {
  serverTime: number
  startTime: number
  endTime: number
  phase: 'upcoming' | 'active' | 'settlement' | 'ended' | 'unavailable'
  seedClaimed: boolean
  canClaimSeed: boolean
  seedStock: number
  cropStock: number
  sellableCropStock: number
  coinBalance: number
  pendingCommissionCoin: number
  pendingCommissionCount: number
  canClaimCommission: boolean
  purchaseLogUnread: boolean
  rules: string[]
  quote: {
    basePrice: number
    boost: number
    unitPrice: number
    complete: boolean
    tier: string | null
    canSell: boolean
    remainingQuota: number
    ownerName?: string
  } | null
  goods: MarketGoods[]
}

interface PurchaseRecord {
  timestamp: number
  sellerGid: number
  sellerName: string
  sellerAvatar: string
  sellerLevel: number
  soldCount: number
  income: number
  commission: number
}

type MainTab = 'shop' | 'exchange' | 'compare'

defineEmits<{ back: [] }>()

const DAILY_QUOTA_CAP = 8000
const COIN_IMAGE = '/game-config/seed_images_named/seed_images/1033.png'
const CROP_IMAGE = '/game-config/seed_images_named/seed_images/1032.png'
const SEED_IMAGE = '/game-config/seed_images_named/seed_images/20307.png'
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const activeTab = ref<MainTab>('shop')
const state = ref<MarketState | null>(null)
const pending = ref<'read' | 'claim' | 'commission' | 'sell' | 'exchange' | null>(null)
const error = ref('')
const rulesOpen = ref(false)
const saleCount = ref(1)
const exchangeOffer = ref<MarketGoods | null>(null)
const purchaseLogOpen = ref(false)
const purchaseLogLoading = ref(false)
const purchaseLogError = ref('')
const purchaseRecords = ref<PurchaseRecord[]>([])
const formatter = new Intl.NumberFormat('zh-CN')
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
const recordTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
let sequence = 0

const tabs = computed<Array<{ key: MainTab, label: string, dot?: boolean }>>(() => [
  { key: 'shop', label: '红薯小铺', dot: !!(state.value?.canClaimSeed || state.value?.canClaimCommission) },
  { key: 'exchange', label: '兑换商店' },
  { key: 'compare', label: '好友比价' },
])

const periodText = computed(() => state.value
  ? `${date.format(state.value.startTime)} – ${date.format(state.value.endTime)}`
  : '')

const phaseBadge = computed(() => {
  const s = state.value
  if (!s)
    return null
  if (s.phase === 'upcoming')
    return { text: '未开始', muted: true }
  if (s.phase === 'settlement')
    return { text: '兑换期', muted: false }
  if (s.phase === 'ended' || s.phase === 'unavailable')
    return { text: '已结束', muted: true }
  const left = Math.ceil((s.endTime - s.serverTime) / 86_400_000)
  return { text: left <= 0 ? '今天结束' : `还剩 ${left} 天`, muted: false }
})

const walletItems = computed(() => {
  const s = state.value
  if (!s)
    return []
  return [
    { key: 'coin', label: '福气币', count: s.coinBalance, image: COIN_IMAGE },
    { key: 'crop', label: '蜜薯', count: s.cropStock, image: CROP_IMAGE },
    { key: 'seed', label: '红薯种子', count: s.seedStock, image: SEED_IMAGE },
  ]
})

const shopTitle = computed(() => {
  const name = state.value?.quote?.ownerName
  return name ? `${name}的红薯小铺` : '我的红薯小铺'
})

const quotaPercent = computed(() => {
  const q = state.value?.quote
  if (!q)
    return null
  return Math.max(0, Math.min(100, (q.remainingQuota / DAILY_QUOTA_CAP) * 100))
})

const commissionHint = computed(() => {
  const count = state.value?.pendingCommissionCount ?? 0
  return count > 0
    ? `${formatter.format(count)} 笔好友成交待领 · 按成交额 2% 分成`
    : '好友通过你的分享出售蜜薯，你获得 2% 福气币分成'
})

const saleIncome = computed(() => {
  const quote = state.value?.quote
  return quote && Number.isSafeInteger(saleCount.value) && saleCount.value > 0
    ? quote.unitPrice * saleCount.value
    : 0
})

const exchangeMax = computed(() => {
  const offer = exchangeOffer.value
  const wallet = state.value?.coinBalance ?? 0
  if (!offer || offer.price <= 0)
    return 0
  return Math.max(0, Math.min(offer.remaining ?? 9999, Math.floor(wallet / offer.price)))
})

/** 活动/兑换期内才允许下单；结束后所有商品都不可兑。 */
const canExchangeNow = computed(() => state.value?.phase === 'active' || state.value?.phase === 'settlement')

const exchangeDialogGoods = computed<MallGoodsDto | null>(() => {
  const offer = exchangeOffer.value
  const current = state.value
  if (!offer || !current)
    return null
  const action = goodsAction(offer)
  return {
    id: offer.id,
    name: offer.name,
    type: 0,
    rewards: offer.items.map(item => ({
      id: item.id,
      count: item.count,
      name: item.name,
      image: item.image,
      rarity: 0,
    })),
    price: {
      id: 1033,
      count: offer.price,
      name: '福气币',
      image: COIN_IMAGE,
      rarity: 0,
      balance: current.coinBalance,
    },
    originalPrice: null,
    isFree: false,
    limit: offer.limitTimes !== null
      ? {
          type: offer.limitType,
          bought: Math.max(0, offer.limitTimes - (offer.remaining ?? 0)),
          max: offer.limitTimes,
          remaining: offer.remaining,
        }
      : null,
    isLimited: offer.limitTimes !== null,
    discountText: '',
    isDiscounted: false,
    discountEndTime: 0,
    available: action.enabled,
    purchasable: action.enabled,
  }
})

const parsedRules = computed(() => (state.value?.rules || []).map((line) => {
  const text = line.trim()
  const titleMatch = text.match(/^【(.+)】$/)
  return {
    title: !!titleMatch,
    text: titleMatch ? titleMatch[1] : text,
  }
}))

function limitLabel(limitType: number) {
  if (limitType === 1)
    return '每日限购'
  if (limitType === 2)
    return '活动限购'
  return '限购'
}

/** 不可兑换时让按钮暗淡不可点；余额足够且开放兑换时才允许打开兑换确认弹窗。 */
function goodsAction(goods: MarketGoods) {
  if (goods.remaining === 0) {
    return {
      enabled: false,
      label: goods.limitType === 1 ? '今日已兑完' : '已兑完',
      reason: goods.limitType === 1 ? '今日兑换次数已达上限' : '活动兑换次数已达上限',
    }
  }
  if (!canExchangeNow.value) {
    return {
      enabled: false,
      label: '暂不可兑',
      reason: '当前活动阶段不可兑换',
    }
  }
  const balance = state.value?.coinBalance ?? 0
  if (goods.price > balance) {
    return {
      enabled: false,
      label: '兑换',
      reason: `福气币不足，还差 ${formatter.format(goods.price - balance)}`,
    }
  }
  if (!goods.exchangeable) {
    return {
      enabled: false,
      label: '暂不可兑',
      reason: '该商品当前暂不可兑换',
    }
  }
  return { enabled: true, label: '兑换', reason: '' }
}

function setSaleCount(value: number | null) {
  const max = Math.max(1, state.value?.sellableCropStock || 1)
  saleCount.value = Math.max(1, Math.min(max, Math.floor(Number(value)) || 1))
}

function selectExchange(offer: MarketGoods) {
  if (!goodsAction(offer).enabled)
    return
  exchangeOffer.value = offer
}

function closeExchange() {
  if (!pending.value)
    exchangeOffer.value = null
}

function confirmExchange(count: number) {
  void request('exchange', count)
}

async function openPurchaseLog() {
  const accountId = currentAccountId.value
  if (!accountId || purchaseLogLoading.value)
    return
  purchaseLogOpen.value = true
  purchaseLogLoading.value = true
  purchaseLogError.value = ''
  try {
    const { data } = await api.get('/api/activities/maple-market/purchase-log', {
      headers: { 'x-account-id': String(accountId) },
      skipErrorToast: true,
    } as any)
    if (!data.ok)
      throw new Error(data.error || '读取收购记录失败')
    purchaseRecords.value = Array.isArray(data.data?.records) ? data.data.records : []
    if (state.value)
      state.value.purchaseLogUnread = false
  }
  catch (cause) {
    purchaseLogError.value = getApiErrorMessage(cause, '读取收购记录失败')
  }
  finally {
    purchaseLogLoading.value = false
  }
}

async function request(action: 'read' | 'claim' | 'commission' | 'sell' | 'exchange' = 'read', exchangeQty = 1) {
  const accountId = currentAccountId.value
  if (!accountId || pending.value || (action === 'claim' && !state.value?.canClaimSeed))
    return
  if (action === 'commission' && !state.value?.canClaimCommission)
    return
  const quote = state.value?.quote
  const offer = exchangeOffer.value
  if (action === 'sell' && (!quote?.canSell || !state.value || !saleIncome.value || saleCount.value > state.value.sellableCropStock))
    return
  if (action === 'exchange' && (!offer || !Number.isSafeInteger(exchangeQty) || exchangeQty < 1 || exchangeQty > exchangeMax.value))
    return
  const revision = ++sequence
  pending.value = action
  error.value = ''
  const options = { headers: { 'x-account-id': String(accountId) }, skipErrorToast: true } as any
  const path = '/api/activities/maple-market'
  try {
    if (action === 'claim') {
      const { data } = await api.post(`${path}/claim-seed`, {}, options)
      if (revision !== sequence)
        return
      if (!data.ok)
        throw new Error(data.error || '领取失败')
      if (data.data.status === 'confirmed')
        toast.success(`已领取红薯种子 ×${data.data.data.seed.count}`)
    }
    else if (action === 'commission') {
      const { data } = await api.post(`${path}/claim-commission`, {}, options)
      if (revision !== sequence)
        return
      if (!data.ok)
        throw new Error(data.error || '领取提成失败')
      if (data.data.status === 'confirmed')
        toast.success(`已领取小铺提成 ${formatter.format(data.data.data.claimedCoin)} 福气币`)
      else
        toast.info(data.data.message || '当前没有可领取的小铺提成')
    }
    else if (action === 'sell' && quote) {
      const { data } = await api.post(`${path}/sell`, { count: saleCount.value, expectedUnitPrice: quote.unitPrice }, options)
      if (revision !== sequence)
        return
      if (!data.ok)
        throw new Error(data.error || '出售失败')
      toast.success(`已卖出 ${data.data.sold} 个蜜薯，获得 ${formatter.format(data.data.income)} 福气币`)
      saleCount.value = 1
    }
    else if (action === 'exchange' && offer) {
      const { data } = await api.post(`${path}/exchange`, {
        goodsId: offer.id,
        count: exchangeQty,
        expectedUnitPrice: offer.price,
      }, options)
      if (revision !== sequence)
        return
      if (!data.ok)
        throw new Error(data.error || '兑换失败')
      toast.success(`已兑换 ${offer.name} ×${data.data.count}，扣除 ${formatter.format(data.data.cost)} 福气币`)
      exchangeOffer.value = null
    }
    const { data } = await api.get(path, options)
    if (revision !== sequence)
      return
    if (!data.ok)
      throw new Error(data.error || '读取活动失败')
    state.value = data.data
    if (exchangeOffer.value)
      exchangeOffer.value = state.value?.goods.find(goods => goods.id === exchangeOffer.value?.id) || null
    if (state.value && saleCount.value > Math.max(1, state.value.sellableCropStock))
      saleCount.value = Math.max(1, state.value.sellableCropStock)
  }
  catch (cause) {
    if (revision !== sequence)
      return
    if (action !== 'read' && state.value) {
      exchangeOffer.value = null
      state.value = {
        ...state.value,
        canClaimSeed: false,
        canClaimCommission: false,
        quote: state.value.quote && { ...state.value.quote, canSell: false },
        goods: state.value.goods.map(goods => ({ ...goods, exchangeable: false })),
      }
    }
    error.value = getApiErrorMessage(cause, '活动请求失败，请刷新后重试')
  }
  finally {
    if (revision === sequence)
      pending.value = null
  }
}

watch(currentAccountId, () => {
  sequence++
  pending.value = null
  error.value = ''
  state.value = null
  activeTab.value = 'shop'
  saleCount.value = 1
  exchangeOffer.value = null
  purchaseLogOpen.value = false
  purchaseRecords.value = []
  purchaseLogError.value = ''
  void request()
}, { immediate: true, flush: 'sync' })

onUnmounted(() => {
  sequence++
})
</script>

<template>
  <section class="maple-page">
    <header class="maple-head">
      <div class="maple-head__lead">
        <NButton secondary circle title="返回活动列表" aria-label="返回活动列表" @click="$emit('back')">
          <template #icon>
            <span class="i-carbon-arrow-left" />
          </template>
        </NButton>
        <div class="maple-head__title">
          <h2>以薯换福</h2>
          <p v-if="periodText">
            <span class="i-carbon-calendar" aria-hidden="true" />{{ periodText }}
            <span v-if="phaseBadge" class="maple-head__badge" :class="{ 'is-muted': phaseBadge.muted }">
              {{ phaseBadge.text }}
            </span>
          </p>
        </div>
      </div>
      <div class="maple-head__actions">
        <NButton v-if="parsedRules.length" secondary circle title="活动说明" aria-label="查看活动说明" @click="rulesOpen = true">
          <template #icon>
            <span class="i-carbon-information" />
          </template>
        </NButton>
        <NButton secondary circle :loading="pending === 'read'" :disabled="!currentAccountId || !!pending" title="刷新活动数据" aria-label="刷新活动数据" @click="request()">
          <template #icon>
            <span class="i-carbon-renew" />
          </template>
        </NButton>
      </div>
    </header>

    <div class="maple-toolbar">
      <NTabs v-model:value="activeTab" type="segment" class="maple-toolbar__tabs" aria-label="以薯换福页签">
        <NTab v-for="item in tabs" :key="item.key" :name="item.key">
          <span class="maple-tab">
            {{ item.label }}
            <i v-if="item.dot" class="maple-tab__dot" aria-label="有可操作项目" />
          </span>
        </NTab>
      </NTabs>
      <ul v-if="walletItems.length" class="maple-wallet" aria-label="活动道具余额">
        <li v-for="item in walletItems" :key="item.key" :title="item.label">
          <span class="maple-wallet__icon" aria-hidden="true">
            <CommerceItemImage :src="item.image" :alt="item.label" size="sm" />
          </span>
          <span class="maple-wallet__label">{{ item.label }}</span>
          <b>{{ formatter.format(item.count) }}</b>
        </li>
      </ul>
    </div>

    <main class="maple-content">
      <p v-if="error" class="maple-error" role="alert">
        <span class="i-carbon-warning-alt" aria-hidden="true" />{{ error }}
      </p>

      <EmptyState v-if="!currentAccountId" title="请先选择账号" icon="i-carbon-user-avatar" />
      <EmptyState
        v-else-if="!state"
        :title="pending === 'read' ? '正在读取活动进度' : '暂未获取到活动数据'"
        :icon="pending === 'read' ? 'i-svg-spinners-90-ring-with-bg' : 'i-carbon-store'"
      >
        <NButton v-if="pending !== 'read'" secondary @click="request()">
          重新加载
        </NButton>
      </EmptyState>

      <template v-else>
        <!-- Tab 1: 红薯小铺 -->
        <div v-if="activeTab === 'shop'" class="maple-shop">
          <section class="maple-card maple-quote" aria-labelledby="maple-quote-title">
            <header class="maple-quote__head">
              <h3 id="maple-quote-title">
                <span class="i-carbon-store" aria-hidden="true" />{{ shopTitle }}
              </h3>
              <span v-if="state.quote?.tier" class="maple-pill">{{ state.quote.tier }}档</span>
            </header>

            <div v-if="state.quote" class="maple-quote__price">
              <div class="maple-quote__total">
                <small>今日收购价</small>
                <strong>{{ formatter.format(state.quote.unitPrice) }}</strong>
                <span>福气币 / 个</span>
              </div>
              <dl class="maple-quote__formula" aria-label="收购价构成">
                <span class="maple-quote__op" aria-hidden="true">=</span>
                <div>
                  <dt>基础价</dt>
                  <dd>{{ formatter.format(state.quote.basePrice) }}</dd>
                </div>
                <span class="maple-quote__op" aria-hidden="true">+</span>
                <div :class="{ 'is-empty': state.quote.boost <= 0 }">
                  <dt>{{ state.quote.boost > 0 ? '分享暴击' : '未分享暴击' }}</dt>
                  <dd>{{ formatter.format(state.quote.boost) }}</dd>
                </div>
              </dl>
            </div>
            <p v-else class="maple-quote__empty">
              {{ state.phase === 'settlement' ? '收购已结束，可前往兑换商店使用福气币' : '当前暂无收购报价' }}
            </p>

            <div v-if="state.quote && quotaPercent !== null" class="maple-quota">
              <div class="maple-quota__label">
                <span>好友剩余可售额度</span>
                <b>{{ formatter.format(state.quote.remainingQuota) }} / {{ formatter.format(DAILY_QUOTA_CAP) }}</b>
              </div>
              <div
                class="maple-track"
                role="progressbar"
                aria-label="好友剩余可售额度"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="Math.round(quotaPercent)"
              >
                <span :style="{ width: `${quotaPercent}%` }" />
              </div>
            </div>

            <p v-if="state.phase === 'active'" class="maple-quote__note">
              <span class="i-carbon-time" aria-hidden="true" />每日 24:00 按自家当日最终价自动结算剩余蜜薯
            </p>
          </section>

          <section class="maple-card maple-tasks" aria-labelledby="maple-tasks-title">
            <header class="maple-card__head">
              <h3 id="maple-tasks-title">
                小铺事项
              </h3>
              <NButton
                v-if="state.phase === 'active' || state.phase === 'settlement'"
                quaternary
                size="small"
                :disabled="!!pending"
                @click="openPurchaseLog"
              >
                <template #icon>
                  <span class="i-carbon-receipt" />
                </template>
                收购记录
                <i v-if="state.purchaseLogUnread" class="maple-btn-dot" aria-label="有未读记录" />
              </NButton>
            </header>
            <ul class="maple-tasks__list">
              <li class="maple-task">
                <span class="maple-task__icon" aria-hidden="true"><span class="i-carbon-sprout" /></span>
                <div class="maple-task__main">
                  <strong>每日红薯种子</strong>
                  <small>每天可领一次，种出蜜薯后出售换福气币</small>
                </div>
                <span v-if="state.seedClaimed" class="maple-task__done">
                  <span class="i-carbon-checkmark" aria-hidden="true" />今日已领
                </span>
                <NButton v-else-if="state.canClaimSeed" type="primary" size="small" :loading="pending === 'claim'" :disabled="!!pending" @click="request('claim')">
                  领取
                </NButton>
                <span v-else class="maple-task__idle">暂不可领</span>
              </li>
              <li class="maple-task">
                <span class="maple-task__icon" aria-hidden="true"><span class="i-carbon-currency" /></span>
                <div class="maple-task__main">
                  <strong>
                    小铺提成
                    <em v-if="state.pendingCommissionCoin > 0">+{{ formatter.format(state.pendingCommissionCoin) }}</em>
                  </strong>
                  <small>{{ commissionHint }}</small>
                </div>
                <NButton v-if="state.canClaimCommission" type="primary" size="small" :loading="pending === 'commission'" :disabled="!!pending" @click="request('commission')">
                  领取
                </NButton>
                <span v-else class="maple-task__idle">暂无待领</span>
              </li>
            </ul>
          </section>

          <aside class="maple-shop__ops">
            <section class="maple-card maple-cashier" aria-labelledby="maple-cashier-title">
              <header class="maple-card__head">
                <div>
                  <h3 id="maple-cashier-title">
                    卖给自家小铺
                  </h3>
                  <p>按今日收购价结算，不占好友额度</p>
                </div>
              </header>
              <template v-if="state.quote?.canSell && state.sellableCropStock > 0">
                <div class="maple-cashier__stock">
                  <span>可卖蜜薯</span>
                  <b>{{ formatter.format(state.sellableCropStock) }} 个</b>
                  <small v-if="state.cropStock > state.sellableCropStock">背包共 {{ formatter.format(state.cropStock) }}，其余已锁定</small>
                </div>
                <div class="maple-quantity">
                  <NInputNumber
                    :value="saleCount"
                    :min="1"
                    :max="state.sellableCropStock"
                    :disabled="!!pending"
                    button-placement="both"
                    aria-label="出售数量"
                    @update:value="setSaleCount"
                  />
                  <NButton secondary :disabled="!!pending || saleCount >= state.sellableCropStock" @click="setSaleCount(state.sellableCropStock)">
                    全部
                  </NButton>
                </div>
                <div class="maple-estimate">
                  <span>{{ formatter.format(saleCount) }} × {{ formatter.format(state.quote.unitPrice) }}</span>
                  <strong>{{ formatter.format(saleIncome) }} <small>福气币</small></strong>
                </div>
                <NButton type="primary" size="large" block :loading="pending === 'sell'" :disabled="!!pending" @click="request('sell')">
                  卖出 {{ formatter.format(saleCount) }} 个
                </NButton>
              </template>
              <p v-else class="maple-cashier__empty">
                {{ state.phase !== 'active' ? '当前阶段已停止收购蜜薯' : '暂无可出售的蜜薯，收获后再来' }}
              </p>
              <button v-if="state.phase === 'active'" type="button" class="maple-link" :disabled="!!pending" @click="activeTab = 'compare'">
                好友出价可能更高，去比价
                <span class="i-carbon-arrow-right" aria-hidden="true" />
              </button>
            </section>
          </aside>
        </div>

        <!-- Tab 2: 兑换商店 -->
        <section v-else-if="activeTab === 'exchange'" class="maple-section" aria-labelledby="maple-goods-title">
          <header class="maple-section__title">
            <h3 id="maple-goods-title">
              兑换商品
            </h3>
            <small>{{ state.goods.length }} 款 · 持有 {{ formatter.format(state.coinBalance) }} 福气币</small>
          </header>
          <EmptyState v-if="!state.goods.length" title="暂无可兑换商品" icon="i-carbon-gift" />
          <ul v-else class="maple-goods">
            <li v-for="goods in state.goods" :key="goods.id" class="maple-card maple-goods-card" :class="{ 'is-off': goods.remaining === 0 }">
              <div class="maple-goods-card__top">
                <div class="maple-item__well">
                  <CommerceItemImage :src="goods.items[0]?.image" :alt="goods.name" />
                  <b v-if="goods.items.length === 1 && (goods.items[0]?.count ?? 0) > 1">×{{ goods.items[0]?.count }}</b>
                </div>
                <div class="maple-goods-card__info">
                  <strong :title="goods.name">{{ goods.name }}</strong>
                  <span v-if="goods.items.length > 1">含 {{ goods.items.length }} 种道具</span>
                  <span>
                    <template v-if="goods.remaining !== null && goods.limitTimes !== null">
                      {{ limitLabel(goods.limitType) }} · 剩 {{ formatter.format(goods.remaining) }} / {{ formatter.format(goods.limitTimes) }}
                    </template>
                    <template v-else>不限兑换次数</template>
                  </span>
                </div>
              </div>
              <div class="maple-goods-card__foot">
                <span class="maple-price">
                  <CommerceItemImage :src="COIN_IMAGE" alt="福气币" size="sm" />
                  {{ formatter.format(goods.price) }}
                </span>
                <NButton
                  size="small"
                  :type="goodsAction(goods).enabled ? 'primary' : 'default'"
                  :secondary="!goodsAction(goods).enabled"
                  :title="goodsAction(goods).reason || undefined"
                  :disabled="!goodsAction(goods).enabled || !!pending"
                  :aria-label="goodsAction(goods).enabled ? `兑换${goods.name}` : `${goods.name}（${goodsAction(goods).reason || goodsAction(goods).label}）`"
                  @click="selectExchange(goods)"
                >
                  {{ goodsAction(goods).label }}
                </NButton>
              </div>
            </li>
          </ul>
        </section>

        <!-- Tab 3: 好友比价（保持挂载，切换页签不中断后台查价） -->
        <section v-show="activeTab === 'compare'">
          <MapleMarketCompare
            v-if="state.phase === 'active' && currentAccountId"
            :key="currentAccountId"
            :account-id="currentAccountId"
            :own-quote="state.quote"
            :stock="state.sellableCropStock"
            :activity-busy="!!pending"
            @sold="request()"
          />
          <EmptyState
            v-else
            title="当前阶段暂不支持好友比价"
            description="仅活动进行期间可查询并出售给好友红薯小铺"
            icon="i-carbon-time"
          />
        </section>
      </template>
    </main>

    <ActivityRulesDialog :open="rulesOpen" title="以薯换福 · 活动说明" @close="rulesOpen = false">
      <div class="maple-rules">
        <p v-for="(line, index) in parsedRules" :key="index" :class="{ 'is-title': line.title }">
          {{ line.text }}
        </p>
      </div>
    </ActivityRulesDialog>

    <!-- 收购记录弹窗 -->
    <NModal :show="purchaseLogOpen" :mask-closable="true" :close-on-esc="true" @update:show="visible => !visible && (purchaseLogOpen = false)">
      <NCard class="maple-modal" title="小铺收购记录" :bordered="false" closable role="dialog" aria-modal="true" @close="purchaseLogOpen = false">
        <div class="maple-modal__body custom-scrollbar">
          <EmptyState v-if="purchaseLogLoading" title="正在读取收购记录" icon="i-svg-spinners-90-ring-with-bg" />
          <p v-else-if="purchaseLogError" class="maple-error" role="alert">
            <span class="i-carbon-warning-alt" aria-hidden="true" />{{ purchaseLogError }}
          </p>
          <EmptyState v-else-if="!purchaseRecords.length" title="暂无收购记录" description="好友通过你的分享在铺子出售蜜薯后，成交和提成记录会显示在这里" icon="i-carbon-store" />
          <ol v-else class="maple-lines">
            <li v-for="(record, idx) in purchaseRecords" :key="`${record.sellerGid}-${record.timestamp}-${idx}`" class="maple-line">
              <span class="maple-line__avatar" aria-hidden="true">{{ record.sellerName.slice(0, 1) }}</span>
              <div class="maple-line__main">
                <strong>{{ record.sellerName }} <small v-if="record.sellerLevel > 0">Lv.{{ record.sellerLevel }}</small></strong>
                <time>{{ recordTime.format(record.timestamp) }} · 卖出 {{ formatter.format(record.soldCount) }} 个蜜薯（{{ formatter.format(record.income) }} 福气币）</time>
              </div>
              <span class="maple-tag">+{{ formatter.format(record.commission) }} 提成</span>
            </li>
          </ol>
        </div>
      </NCard>
    </NModal>

    <PurchaseDialog
      :open="!!exchangeDialogGoods"
      :goods="exchangeDialogGoods"
      :limit-label="exchangeOffer ? limitLabel(exchangeOffer.limitType) : undefined"
      :pending="pending === 'exchange'"
      verb="兑换"
      @close="closeExchange"
      @confirm="confirmExchange"
    />
  </section>
</template>

<style scoped>
.maple-page {
  display: flex;
  flex-direction: column;
  container: maple-page / inline-size;
}

.maple-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 14px 4px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.maple-head__lead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.maple-head__title {
  min-width: 0;
  flex: 1;
}

.maple-head__title h2 {
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 18px;
  font-weight: var(--fw-700);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.maple-head__title p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-head__actions {
  display: flex;
  gap: 8px;
}

.maple-head__badge {
  padding: 0 7px;
  border-radius: 999px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.maple-head__badge.is-muted {
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
}

.maple-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
}

.maple-toolbar__tabs {
  width: 360px;
}

.maple-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.maple-tab__dot,
.maple-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-danger);
}

.maple-btn-dot {
  margin-left: 6px;
}

.maple-wallet {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-wallet li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px 3px 4px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-surface);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.maple-wallet__icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 999px;
  background: var(--ui-primary-soft);
}

.maple-wallet__icon :deep(.item-image--sm) {
  width: 22px;
  height: 22px;
  border: 0;
  background: transparent;
}

.maple-wallet__label {
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-wallet b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.maple-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding: 16px 0 32px;
  color: var(--ui-ink);
  container: maple-content / inline-size;
}

.maple-error {
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

.maple-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--ui-shadow-sm);
}

.maple-shop {
  display: grid;
  grid-template-areas:
    'quote'
    'ops'
    'tasks';
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.maple-quote {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px;
  grid-area: quote;
}

.maple-tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 20px 10px;
  grid-area: tasks;
}

.maple-shop__ops {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  grid-area: ops;
}

.maple-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.maple-card__head h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
}

.maple-card__head p {
  margin: 3px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

/* —— 今日行情 —— */
.maple-quote__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.maple-quote__head h3 {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.maple-quote__head h3 > span {
  flex: none;
  color: var(--ui-primary);
  font-size: 16px;
}

.maple-pill {
  flex: none;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.maple-quote__price {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 16px;
}

.maple-quote__total {
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  column-gap: 8px;
}

.maple-quote__total small {
  grid-column: 1 / -1;
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-quote__total strong {
  color: var(--ui-primary);
  font-size: 40px;
  font-weight: var(--fw-700);
  line-height: 1.05;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.maple-quote__total span {
  color: var(--ui-muted);
  font-size: 13px;
}

.maple-quote__formula {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin: 0;
}

.maple-quote__formula > div {
  display: flex;
  min-width: 84px;
  flex-direction: column-reverse;
  gap: 1px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.maple-quote__formula dt {
  color: var(--ui-muted);
  font-size: 11px;
}

.maple-quote__formula dd {
  margin: 0;
  color: var(--ui-ink);
  font-size: 17px;
  font-weight: var(--fw-650);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.maple-quote__formula > div:last-child:not(.is-empty) {
  background: var(--ui-warning-soft);
}

.maple-quote__formula > div:last-child:not(.is-empty) dd {
  color: var(--ui-warning);
}

.maple-quote__formula > div.is-empty dd {
  color: var(--ui-subtle);
}

.maple-quote__op {
  align-self: center;
  color: var(--ui-subtle);
  font-size: 15px;
}

.maple-quote__empty {
  margin: 0;
  padding: 14px 16px;
  border-radius: 12px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
}

.maple-quota {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.maple-quota__label {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-quota__label b {
  color: var(--ui-ink);
  font-weight: var(--fw-600);
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
  transition: width 0.3s ease;
}

.maple-quote__note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding-top: 12px;
  border-top: 1px dashed var(--ui-border-strong);
  color: var(--ui-subtle);
  font-size: 12px;
}

/* —— 小铺事项 —— */
.maple-tasks__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-task {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 10px 0;
}

.maple-task + .maple-task {
  border-top: 1px solid var(--ui-border);
}

.maple-task__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  border-radius: 10px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 18px;
}

.maple-task__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.maple-task__main strong {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-600);
}

.maple-task__main em {
  color: var(--ui-primary);
  font-size: 14px;
  font-style: normal;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}

.maple-task__main small {
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-task__done,
.maple-task__idle {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.maple-task__done {
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

/* —— 收银台 —— */
.maple-cashier {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}

.maple-cashier__stock {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  color: var(--ui-muted);
  font-size: 13px;
}

.maple-cashier__stock b {
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.maple-cashier__stock small {
  flex-basis: 100%;
  color: var(--ui-subtle);
  font-size: 12px;
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

.maple-cashier__empty {
  margin: 0;
  padding: 18px 12px;
  border-radius: 12px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
  text-align: center;
}

.maple-link {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 0;
  border-radius: 6px;
  color: var(--ui-muted);
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.maple-link:hover:not(:disabled) {
  color: var(--ui-primary);
}

.maple-link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.maple-link:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* —— 兑换商店 —— */
.maple-section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.maple-section__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.maple-section__title h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.maple-section__title small {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-goods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-goods-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}

.maple-goods-card__top {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.maple-goods-card__info {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.maple-goods-card__info strong {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.maple-goods-card__info span {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-item__well {
  position: relative;
  display: grid;
  width: 56px;
  height: 56px;
  flex: none;
  place-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.maple-item__well :deep(.item-image) {
  width: 84%;
  height: 84%;
  border: 0;
  background: transparent;
}

.maple-item__well b {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 0 5px;
  border-radius: 999px;
  color: #fff;
  background: rgba(24, 32, 27, 0.62);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 16px;
}

.maple-goods-card.is-off .maple-item__well {
  filter: grayscale(0.6);
  opacity: 0.7;
}

.maple-goods-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  padding-top: 10px;
  border-top: 1px dashed var(--ui-border-strong);
}

.maple-price {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-700);
  font-variant-numeric: tabular-nums;
}

.maple-price :deep(.item-image--sm) {
  width: 18px;
  height: 18px;
  border: 0;
  background: transparent;
}

.maple-goods-card.is-off .maple-price {
  color: var(--ui-subtle);
}

/* —— 活动说明 —— */
.maple-rules p {
  margin: 0 0 8px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.7;
}

.maple-rules p.is-title {
  margin-top: 14px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.maple-rules p.is-title:first-child {
  margin-top: 0;
}

/* —— 弹窗 —— */
.maple-modal {
  display: flex;
  width: min(620px, calc(100vw - 32px));
  max-height: min(86dvh, 840px);
  flex-direction: column;
  overflow: hidden;
}

.maple-modal :deep(.n-card-content) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.maple-modal__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
}

.maple-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.maple-line__avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 14px;
  font-weight: var(--fw-700);
}

.maple-line__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.maple-line__main strong {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.maple-line__main small {
  margin-left: 4px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
}

.maple-line__main time {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 12px;
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@container maple-content (min-width: 980px) {
  .maple-shop {
    grid-template-areas:
      'quote ops'
      'tasks ops';
    grid-template-columns: minmax(0, 1fr) 340px;
    grid-template-rows: auto 1fr;
    gap: 16px 20px;
  }

  .maple-shop__ops {
    position: sticky;
    top: 0;
  }
}

@container maple-page (max-width: 600px) {
  .maple-toolbar__tabs {
    width: 100%;
  }
}

@media (max-width: 520px) {
  .maple-goods {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
</style>
