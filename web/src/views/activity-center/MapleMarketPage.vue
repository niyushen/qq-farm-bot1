<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import MapleMarketCompare from '@/components/activity/MapleMarketCompare.vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import BookOverview from '@/components/illustrated/BookOverview.vue'
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
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const activeTab = ref<MainTab>('shop')
const state = ref<MarketState | null>(null)
const pending = ref<'read' | 'claim' | 'commission' | 'sell' | 'exchange' | null>(null)
const error = ref('')
const rulesOpen = ref(false)
const saleCount = ref(1)
const exchangeCount = ref(1)
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
    { key: 'coin', label: '福气币', count: s.coinBalance, icon: 'i-carbon-currency' },
    { key: 'crop', label: '蜜薯', count: s.cropStock, icon: 'i-carbon-gift' },
    { key: 'seed', label: '红薯种子', count: s.seedStock, icon: 'i-carbon-sprout' },
  ]
})

const shopTitle = computed(() => {
  const name = state.value?.quote?.ownerName
  return name ? `${name}的红薯小铺` : '我的红薯小铺'
})

const shopCaption = computed(() => {
  const q = state.value?.quote
  if (!q)
    return state.value?.phase === 'settlement' ? '收购已结束，当前可前往兑换商店兑换奖励' : '当前暂无收购报价'
  const tier = q.tier ? `（${q.tier}）` : ''
  const boostText = q.boost > 0 ? `分享暴击 +${formatter.format(q.boost)}` : '今日尚未分享暴击'
  return `基础价 ${formatter.format(q.basePrice)}${tier} · ${boostText}`
})

const quotaPercent = computed(() => {
  const q = state.value?.quote
  if (!q)
    return null
  return Math.max(0, Math.min(100, (q.remainingQuota / DAILY_QUOTA_CAP) * 100))
})

const seedText = computed(() => {
  if (state.value?.seedClaimed)
    return '今日已领种子'
  return state.value?.canClaimSeed ? '领取今日种子' : '暂不可领取'
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

const exchangeInsufficient = computed(() => {
  const offer = exchangeOffer.value
  const wallet = state.value?.coinBalance ?? 0
  return !!offer && offer.price * (exchangeCount.value || 0) > wallet
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

function setSaleCount(value: number | null) {
  const max = Math.max(1, state.value?.sellableCropStock || 1)
  saleCount.value = Math.max(1, Math.min(max, Math.floor(Number(value)) || 1))
}

function setExchangeCount(value: number | null) {
  const max = Math.max(1, exchangeOffer.value?.remaining ?? 9999)
  exchangeCount.value = Math.max(1, Math.min(max, Math.floor(Number(value)) || 1))
}

function selectExchange(offer: MarketGoods) {
  exchangeCount.value = 1
  exchangeOffer.value = offer
}

function closeExchange() {
  if (!pending.value)
    exchangeOffer.value = null
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

async function request(action: 'read' | 'claim' | 'commission' | 'sell' | 'exchange' = 'read') {
  const accountId = currentAccountId.value
  if (!accountId || pending.value || (action === 'claim' && !state.value?.canClaimSeed))
    return
  if (action === 'commission' && !state.value?.canClaimCommission)
    return
  const quote = state.value?.quote
  const offer = exchangeOffer.value
  if (action === 'sell' && (!quote?.canSell || !state.value || !saleIncome.value || saleCount.value > state.value.sellableCropStock))
    return
  if (action === 'exchange' && (!offer || !Number.isSafeInteger(exchangeCount.value) || exchangeCount.value < 1 || exchangeCount.value > exchangeMax.value))
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
        count: exchangeCount.value,
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
      <NButton secondary circle :loading="pending === 'read'" :disabled="!currentAccountId || !!pending" title="刷新活动数据" aria-label="刷新活动数据" @click="request()">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
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
          <span class="maple-wallet__icon" aria-hidden="true"><span :class="item.icon" /></span>
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
          <BookOverview
            class="maple-shop__overview"
            :title="shopTitle"
            icon="i-carbon-store"
            :badge-value="state.quote ? formatter.format(state.quote.unitPrice) : '—'"
            badge-label="今日收购价"
            :caption="shopCaption"
            :percent="quotaPercent"
            hint="好友可用接收额度"
            :progress-text="state.quote ? `${formatter.format(state.quote.remainingQuota)} / ${formatter.format(DAILY_QUOTA_CAP)}` : ''"
          >
            <template #actions>
              <NButton :type="state.canClaimSeed ? 'primary' : 'default'" :secondary="!state.canClaimSeed" :loading="pending === 'claim'" :disabled="!state.canClaimSeed || !!pending" @click="request('claim')">
                {{ seedText }}
              </NButton>
              <NButton v-if="state.phase === 'active'" secondary :disabled="!!pending" @click="activeTab = 'compare'">
                好友比价
              </NButton>
            </template>
            <span v-if="state.quote?.tier" class="book-chip">基础档：{{ state.quote.tier }}</span>
            <span v-if="state.quote" class="book-chip">
              {{ state.quote.boost > 0 ? `分享暴击 +${formatter.format(state.quote.boost)}` : '未分享暴击' }}
            </span>
            <span v-if="state.phase === 'active'" class="book-chip-label">
              每日 24:00 按自家当日最终价自动结算剩余蜜薯
            </span>
          </BookOverview>

          <section class="maple-card maple-shop__commission">
            <header class="maple-card__head">
              <div>
                <h3>小铺提成与收购记录</h3>
                <p>好友通过你的分享来出售蜜薯时，你将获得 2% 福气币分红</p>
              </div>
              <NButton v-if="state.phase === 'active' || state.phase === 'settlement'" secondary :disabled="!!pending" @click="openPurchaseLog">
                收购记录
                <i v-if="state.purchaseLogUnread" class="maple-btn-dot" aria-label="有未读记录" />
              </NButton>
            </header>
            <div class="maple-commission__body">
              <div class="maple-commission__metric">
                <span>待领提成</span>
                <strong>{{ formatter.format(state.pendingCommissionCoin) }} <small>福气币</small></strong>
                <em v-if="state.pendingCommissionCount > 0">{{ formatter.format(state.pendingCommissionCount) }} 笔好友成交待领</em>
                <em v-else>暂无待领提成</em>
              </div>
              <NButton
                :type="state.canClaimCommission ? 'primary' : 'default'"
                :secondary="!state.canClaimCommission"
                :loading="pending === 'commission'"
                :disabled="!state.canClaimCommission || !!pending"
                @click="request('commission')"
              >
                {{ state.canClaimCommission ? `领取提成 (+${formatter.format(state.pendingCommissionCoin)})` : '暂无可领提成' }}
              </NButton>
            </div>
          </section>

          <aside class="maple-shop__ops">
            <section class="maple-card maple-cashier" aria-labelledby="maple-cashier-title">
              <header class="maple-card__head">
                <div>
                  <h3 id="maple-cashier-title">
                    卖给自己小铺
                  </h3>
                  <p>按自家今日最终收购价出售，不占好友接收额度</p>
                </div>
              </header>
              <dl class="maple-ledger-mini">
                <div>
                  <dt>自家收购单价</dt>
                  <dd>{{ state.quote ? `${formatter.format(state.quote.unitPrice)} 福气币 / 个` : '暂不可售' }}</dd>
                </div>
                <div>
                  <dt>可用蜜薯</dt>
                  <dd>
                    {{ formatter.format(state.sellableCropStock) }} 个
                    <small v-if="state.cropStock > state.sellableCropStock">（背包共 {{ formatter.format(state.cropStock) }}）</small>
                  </dd>
                </div>
              </dl>
              <template v-if="state.quote?.canSell && state.sellableCropStock > 0">
                <div class="maple-confirm__quantity">
                  <span>出售数量</span>
                  <NInputNumber
                    :value="saleCount"
                    :min="1"
                    :max="state.sellableCropStock"
                    :disabled="!!pending"
                    aria-label="出售数量"
                    @update:value="setSaleCount"
                  />
                  <NButton secondary :disabled="!!pending || saleCount >= state.sellableCropStock" @click="setSaleCount(state.sellableCropStock)">
                    最大
                  </NButton>
                </div>
                <div class="maple-estimate">
                  <span>预计到账</span>
                  <strong>{{ formatter.format(saleIncome) }} 福气币</strong>
                </div>
                <div class="maple-cashier__actions">
                  <NButton type="primary" size="large" block :loading="pending === 'sell'" :disabled="!!pending" @click="request('sell')">
                    卖给自己
                  </NButton>
                  <NButton secondary block :disabled="!!pending" @click="activeTab = 'compare'">
                    去好友比价看看更高价
                  </NButton>
                </div>
              </template>
              <div v-else class="maple-cashier__empty">
                <p>{{ state.phase !== 'active' ? '当前阶段已停止收购蜜薯' : '当前暂无可出售的未锁定蜜薯' }}</p>
                <NButton v-if="state.phase === 'active'" secondary block :disabled="!!pending" @click="activeTab = 'compare'">
                  查看好友收购价
                </NButton>
              </div>
            </section>
          </aside>
        </div>

        <!-- Tab 2: 兑换商店 -->
        <section v-else-if="activeTab === 'exchange'" class="maple-section" aria-labelledby="maple-goods-title">
          <header class="maple-section__title">
            <h3 id="maple-goods-title">
              兑换商品
            </h3>
            <small>{{ state.goods.length }} 款</small>
          </header>
          <EmptyState v-if="!state.goods.length" title="暂无可兑换商品" icon="i-carbon-gift" />
          <ul v-else class="maple-goods">
            <li v-for="goods in state.goods" :key="goods.id" class="maple-card maple-goods-card" :class="{ 'is-off': !goods.exchangeable }">
              <strong class="maple-goods-card__name" :title="goods.name">{{ goods.name }}</strong>
              <div class="maple-item__well">
                <CommerceItemImage :src="goods.items[0]?.image" :alt="goods.name" />
                <b v-if="goods.items.length === 1 && (goods.items[0]?.count ?? 0) > 1">×{{ goods.items[0]?.count }}</b>
              </div>
              <span class="maple-goods-card__meta">
                <template v-if="goods.remaining !== null && goods.limitTimes !== null">
                  {{ limitLabel(goods.limitType) }} {{ formatter.format(goods.remaining) }} / {{ formatter.format(goods.limitTimes) }}
                </template>
                <template v-else>
                  不限兑换次数
                </template>
              </span>
              <NButton
                class="maple-goods-card__buy"
                :type="goods.exchangeable ? 'primary' : 'default'"
                :secondary="!goods.exchangeable"
                block
                :disabled="!goods.exchangeable || !!pending"
                @click="selectExchange(goods)"
              >
                <template v-if="goods.remaining === 0">
                  已售罄
                </template>
                <span v-else class="maple-price">
                  <span class="i-carbon-currency" aria-hidden="true" />
                  {{ formatter.format(goods.price) }}
                </span>
              </NButton>
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

        <!-- 底部可折叠活动说明 -->
        <section v-if="parsedRules.length" class="maple-section">
          <button type="button" class="maple-section__toggle" :aria-expanded="rulesOpen" aria-controls="maple-rules" @click="rulesOpen = !rulesOpen">
            活动说明
            <span class="maple-section__chevron i-carbon-chevron-down" :class="{ 'is-open': rulesOpen }" aria-hidden="true" />
          </button>
          <div v-if="rulesOpen" id="maple-rules" class="maple-card maple-rules">
            <p v-for="(line, index) in parsedRules" :key="index" :class="{ 'is-title': line.title }">
              {{ line.text }}
            </p>
          </div>
        </section>
      </template>
    </main>

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

    <!-- 兑换确认弹窗 -->
    <NModal :show="!!exchangeOffer" :mask-closable="!pending" :close-on-esc="!pending" @update:show="visible => !visible && closeExchange()">
      <NCard class="maple-confirm" :title="exchangeOffer ? `兑换 · ${exchangeOffer.name}` : '兑换确认'" :bordered="false" :closable="!pending" role="dialog" aria-modal="true" @close="closeExchange">
        <div v-if="exchangeOffer" class="maple-confirm__body">
          <section class="maple-ledger" aria-label="将获得">
            <h4>将获得</h4>
            <ul>
              <li v-for="item in exchangeOffer.items" :key="item.id">
                <CommerceItemImage :src="item.image" :alt="item.name" size="sm" />
                <span class="maple-ledger__name">{{ item.name }}</span>
                <b>×{{ formatter.format(item.count * (exchangeCount || 0)) }}</b>
              </li>
            </ul>
          </section>
          <div class="maple-confirm__quantity">
            <span>兑换份数</span>
            <NInputNumber
              :value="exchangeCount"
              :min="1"
              :max="Math.max(1, exchangeOffer.remaining ?? 9999)"
              :disabled="!!pending"
              aria-label="兑换份数"
              @update:value="setExchangeCount"
            />
            <NButton secondary :disabled="!!pending || exchangeMax <= 0 || exchangeCount >= exchangeMax" @click="setExchangeCount(exchangeMax)">
              最大
            </NButton>
          </div>
          <section class="maple-ledger" aria-label="将消耗">
            <h4>将消耗</h4>
            <ul>
              <li :class="{ 'is-short': exchangeInsufficient }">
                <span class="maple-ledger__coin" aria-hidden="true"><span class="i-carbon-currency" /></span>
                <span class="maple-ledger__name">福气币</span>
                <small>持有 {{ formatter.format(state?.coinBalance || 0) }}</small>
                <b>×{{ formatter.format(exchangeOffer.price * (exchangeCount || 0)) }}</b>
              </li>
            </ul>
          </section>
          <p v-if="exchangeInsufficient" class="maple-confirm__error" role="alert">
            <span class="i-carbon-warning-alt" aria-hidden="true" />福气币数量不足
          </p>
        </div>
        <template #footer>
          <div class="maple-confirm__actions">
            <NButton :disabled="!!pending" @click="closeExchange">
              取消
            </NButton>
            <NButton type="primary" :loading="pending === 'exchange'" :disabled="!!pending || exchangeInsufficient || exchangeCount < 1" @click="request('exchange')">
              确认兑换
            </NButton>
          </div>
        </template>
      </NCard>
    </NModal>
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
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 14px;
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
    'overview'
    'ops'
    'commission';
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}

.maple-shop__overview {
  grid-area: overview;
}

.maple-shop__commission {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
  grid-area: commission;
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
  flex-wrap: wrap;
  align-items: flex-start;
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

.maple-commission__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.maple-commission__metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.maple-commission__metric span {
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-commission__metric strong {
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.maple-commission__metric small {
  font-size: 12px;
  font-weight: var(--fw-400);
  color: var(--ui-muted);
}

.maple-commission__metric em {
  font-style: normal;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.maple-cashier {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
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
  color: var(--ui-subtle);
  font-size: 12px;
  font-weight: var(--fw-400);
}

.maple-estimate {
  display: flex;
  align-items: center;
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
  font-size: 16px;
  font-weight: var(--fw-700);
}

.maple-cashier__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.maple-cashier__empty {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 0 4px;
  color: var(--ui-muted);
  font-size: 13px;
  text-align: center;
}

.maple-cashier__empty p {
  margin: 0;
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
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-goods-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 14px;
  text-align: center;
}

.maple-goods-card__name {
  max-width: 100%;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.maple-item__well {
  position: relative;
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
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
  right: 4px;
  bottom: 4px;
  padding: 0 5px;
  border-radius: 999px;
  color: #fff;
  background: rgba(24, 32, 27, 0.62);
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 16px;
}

.maple-goods-card.is-off .maple-item__well {
  filter: grayscale(0.55);
  opacity: 0.78;
}

.maple-goods-card__meta {
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-goods-card__buy {
  margin-top: auto;
}

.maple-price {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

/* —— 活动说明 —— */
.maple-section__toggle {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border: 0;
  color: var(--ui-ink);
  background: transparent;
  font: inherit;
  font-size: 14px;
  font-weight: var(--fw-650);
  cursor: pointer;
}

.maple-section__toggle:hover {
  color: var(--ui-primary);
}

.maple-section__chevron {
  color: var(--ui-subtle);
  transition: transform var(--spring-drag-duration) var(--spring-drag);
}

.maple-section__chevron.is-open {
  transform: rotate(180deg);
}

.maple-rules {
  padding: 16px 22px;
  column-width: 400px;
  column-gap: 36px;
}

.maple-rules p {
  margin: 0 0 6px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.65;
  break-inside: avoid;
}

.maple-rules p.is-title {
  margin-top: 8px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
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

.maple-confirm :deep(.n-card-content) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.maple-confirm__body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}

.maple-confirm__quantity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  color: var(--ui-muted);
  font-size: 13px;
}

.maple-ledger h4 {
  margin: 0 0 6px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: var(--fw-600);
}

.maple-ledger ul {
  margin: 0;
  padding: 2px 14px;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  list-style: none;
}

.maple-ledger li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  font-size: 14px;
}

.maple-ledger__coin {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
  font-size: 18px;
}

.maple-ledger__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.maple-ledger small {
  flex: none;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-ledger b {
  flex: none;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
  font-variant-numeric: tabular-nums;
}

.maple-ledger li.is-short small,
.maple-ledger li.is-short b {
  color: var(--ui-danger);
}

.maple-confirm__error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ui-danger);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.maple-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@container maple-content (min-width: 980px) {
  .maple-shop {
    grid-template-areas:
      'overview ops'
      'commission ops';
    grid-template-columns: minmax(0, 1fr) 360px;
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .maple-confirm__actions > :deep(.n-button) {
    flex: 1;
  }
}
</style>
