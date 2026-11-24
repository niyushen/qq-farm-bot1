<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { storeToRefs } from 'pinia'

/**
 * 好友申请（移植 BUGDey v2.18.12）：分享卡片号池 + 主动加好友。
 * 号池全账号共享；申请状态、每日上限按账号隔离（后端按 x-account-id 区分）。
 */
const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)

const loading = ref(false)
const applying = ref(false)
const importing = ref(false)
const pool = ref<any>({ items: [], counts: {}, total: 0, dailyLimit: null })
const shareText = ref('')
const selected = ref<Set<string>>(new Set())
const filter = ref('all')
const result = ref('')
/** apply = 进入农场拿令牌发申请（需对方同意）；force = 点卡片直加（服务端直接绑定） */
const mode = ref<'apply' | 'force'>('force')
const showCollector = ref(false)
const panelOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3007'

const modeHints: Record<string, string> = {
  force: '只上报分享点击，服务端直接绑定好友，无需对方同意；必须带 openid，且 openid 要与 share_key 的主人一致。',
  apply: '进入对方农场拿申请令牌再发申请，需要「点击分享链接可拜访好友」开关，对方要点同意。',
}

const statusLabels: Record<string, string> = {
  all: '全部', new: '未申请', pending: '待通过', expired: '已过期', dead: '不可加', friend: '已好友',
}
const statusColors: Record<string, string> = {
  new: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  expired: 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  dead: 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300',
  friend: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
}

const items = computed<any[]>(() => pool.value?.items || [])
const visibleItems = computed(() => filter.value === 'all' ? items.value : items.value.filter((item: any) => item.status === filter.value))
const selectedItems = computed(() => items.value.filter((item: any) => selected.value.has(String(item.uid))))

function headers() {
  return { headers: { 'x-account-id': String(currentAccountId.value || '') } }
}

async function loadPool() {
  if (!currentAccountId.value) return
  loading.value = true
  try {
    const { data } = await api.get('/api/friends/pool', headers())
    if (data?.ok)
      pool.value = data.data || { items: [], counts: {}, total: 0 }
  }
  catch {
    // 读取失败保留空号池，用户可通过页面提示重试。
  }
  finally {
    loading.value = false
  }
}

async function importCodes() {
  if (!shareText.value.trim() || importing.value) return
  importing.value = true
  result.value = ''
  try {
    const { data } = await api.post('/api/friends/pool/import', { text: shareText.value })
    if (data?.ok) {
      result.value = data.data.parsed > 0
        ? `已导入 ${data.data.added} 条、更新 ${data.data.updated} 条（识别 ${data.data.parsed} 条分享卡片）`
        : '未识别到有效卡片：每行至少要有 uid，并且带 openid 或 share_key。可粘贴采集器 JSON 或形如 ?uid=...&openid=...&share_key=... 的链接。'
      if (data.data.parsed > 0) shareText.value = ''
      await loadPool()
    }
  } finally {
    importing.value = false
  }
}

function toggleSelect(uid: string) {
  const next = new Set(selected.value)
  const key = String(uid)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}

async function applySelected() {
  const targets = selectedItems.value
  if (!targets.length || applying.value) return
  applying.value = true
  result.value = ''
  try {
    const { data } = await api.post('/api/friends/apply-invites', {
      items: targets.map((item: any) => ({
        uid: item.uid, openid: item.openid, shareKey: item.shareKey, shareSource: item.shareSource,
      })),
      options: { mode: mode.value },
    }, headers())
    if (data?.ok) {
      const r = data.data || {}
      const head = mode.value === 'force'
        ? `强制添加完成：已直加 ${r.friend || 0} / 跳过 ${r.skipped || 0} / 失败 ${r.failed || 0}`
        : `申请完成：成功 ${r.applied || 0} / 跳过 ${r.skipped || 0} / 失败 ${r.failed || 0}`
      result.value = `${head}${r.aborted ? `；已中断：${r.aborted}` : ''}`
      selected.value = new Set()
      await loadPool()
    }
  } finally {
    applying.value = false
  }
}

watch(currentAccountId, () => loadPool())
onMounted(loadPool)
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
      <span class="text-gray-700 font-medium dark:text-gray-300">好友申请</span>
      <span class="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
      <span>分享卡片号池全账号共享，申请状态与每日上限按账号隔离</span>
      <span class="ml-auto text-xs">共 {{ pool.total || 0 }} 条</span>
    </div>

    <div v-if="pool.dailyLimit" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
      今日好友申请已达上限，明天再试（{{ pool.dailyLimit.error }}）
    </div>

    <section class="farm-card rounded-lg p-4 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">添加方式</h4>
        <div class="flex overflow-hidden rounded-lg border border-gray-200 text-xs dark:border-gray-700">
          <button
            type="button"
            class="px-3 py-1 transition"
            :class="mode === 'force' ? 'bg-[var(--theme-primary)] text-white' : 'bg-white text-gray-600 dark:bg-gray-900 dark:text-gray-300'"
            @click="mode = 'force'"
          >强制添加</button>
          <button
            type="button"
            class="px-3 py-1 transition"
            :class="mode === 'apply' ? 'bg-[var(--theme-primary)] text-white' : 'bg-white text-gray-600 dark:bg-gray-900 dark:text-gray-300'"
            @click="mode = 'apply'"
          >申请添加</button>
        </div>
      </div>
      <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ modeHints[mode] }}</p>
    </section>

    <section class="farm-card rounded-lg p-4 space-y-3">
      <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">导入分享卡片</h4>
      <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        支持采集器推送/导出的 JSON（<code>{"users":[{"gid","shareKey","openid","shareCfgId"}]}</code>）或每行一条 <code>?uid=...&openid=...&share_key=...</code> 链接。
        <b>每行至少要有 uid，并带 openid 或 share_key</b>；强制添加模式必须带 openid（且要与该 share_key 的主人一致）。
      </p>
      <textarea
        v-model="shareText"
        rows="4"
        class="w-full rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700 outline-none focus:border-[var(--theme-primary)] dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        placeholder="粘贴分享链接，每行一条…"
      />
      <div class="flex items-center gap-2">
        <BaseButton variant="primary" size="sm" :loading="importing" :disabled="!shareText.trim()" @click="importCodes">导入号池</BaseButton>
        <span v-if="result" class="text-xs text-gray-500 dark:text-gray-400">{{ result }}</span>
      </div>
    </section>

    <section class="farm-card rounded-lg p-4 space-y-3">
      <button type="button" class="flex w-full items-center gap-2 text-left" @click="showCollector = !showCollector">
        <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">接采集器（自动灌号池）</h4>
        <span class="i-carbon-chevron-down text-xs text-gray-400 transition" :class="showCollector ? 'rotate-180' : ''" />
        <span class="ml-auto text-xs text-gray-400">点开看配置</span>
      </button>
      <div v-if="showCollector" class="space-y-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        <p>采集器里设 <code>PANEL_URL</code> 指向本面板，导入接口已按采集器的路径与字段做好兼容，脚本本身一行都不用改：</p>
        <pre class="overflow-x-auto rounded-lg bg-gray-50 p-3 text-[11px] dark:bg-gray-900">PANEL_URL={{ panelOrigin }}
PANEL_USER=admin
PANEL_PASS=你的面板密码
ACCOUNT_ID=1
AUTO_IMPORT=1</pre>
        <p>采集器调的是 <code>POST /api/auto-friend/pool/import</code>（body <code>{"users":[...]}</code>），本面板已实现该路径，返回 <code>added / updated / skipped</code> 与采集器期望一致。</p>
        <p>两种运行方式：<code>python collect.py</code>（需 WeChatFerry + PC 微信 3.9.12.51）或 <code>python server.py</code>（HTTP 接收，配合 pywxrobot4 推送插件，默认监听 127.0.0.1:9898）。</p>
      </div>
    </section>

    <section class="farm-card rounded-lg p-4 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="(label, key) in statusLabels"
          :key="key"
          type="button"
          class="rounded-full px-3 py-1 text-xs transition"
          :class="filter === key ? 'bg-[var(--theme-primary)] text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'"
          @click="filter = key"
        >
          {{ label }}<template v-if="pool.counts?.[key]"> {{ pool.counts[key] }}</template>
        </button>
        <BaseButton class="ml-auto" variant="secondary" size="sm" :disabled="!selectedItems.length || applying" :loading="applying" @click="applySelected">
          {{ mode === 'force' ? '批量强制添加' : '批量申请' }}（已选 {{ selectedItems.length }}）
        </BaseButton>
      </div>

      <div v-if="loading" class="py-8 text-center text-xs text-gray-500">加载中...</div>
      <div v-else-if="!visibleItems.length" class="py-8 text-center text-xs text-gray-500">暂无记录，先导入分享卡片</div>
      <div v-else class="max-h-[420px] space-y-2 overflow-y-auto">
        <label
          v-for="item in visibleItems"
          :key="item.uid"
          class="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700"
        >
          <input type="checkbox" :checked="selected.has(String(item.uid))" @change="toggleSelect(item.uid)">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm text-gray-800 dark:text-gray-100">{{ item.name || `GID ${item.uid}` }}</div>
            <div class="truncate text-xs text-gray-500 dark:text-gray-400">
              Lv.{{ item.level || '?' }} · {{ item.dogBreed || '犬种未知' }} · GID {{ item.uid }} · 已申请 {{ item.applyCount || 0 }} 次
              <template v-if="!item.openid"> · 缺 openid</template>
            </div>
          </div>
          <span class="shrink-0 rounded px-2 py-0.5 text-xs" :class="statusColors[item.status] || statusColors.new">
            {{ statusLabels[item.status] || item.status }}
          </span>
        </label>
      </div>
    </section>
  </div>
</template>
