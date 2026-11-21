<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import api from '@/api'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const toast = useToastStore()

// 普通用户是否可见全部农场账号（默认关闭：普通用户只能看到自己添加的账号）
const usersSeeAllAccounts = ref(false)
const visibilityLoaded = ref(false)
const visibilitySaving = ref(false)

async function loadVisibility() {
  try {
    const res = await api.get('/api/admin/account-visibility')
    if (res.data?.ok)
      usersSeeAllAccounts.value = res.data.data?.usersSeeAllAccounts === true
    visibilityLoaded.value = true
  }
  catch {
    toast.error('读取账号可见性设置失败')
  }
}

async function rollbackVisibility(target: boolean) {
  usersSeeAllAccounts.value = target
  await nextTick()
  usersSeeAllAccounts.value = !target
}

async function toggleVisibility(value: boolean | undefined) {
  if (visibilitySaving.value)
    return
  visibilitySaving.value = true
  try {
    const res = await api.post('/api/admin/account-visibility', { usersSeeAllAccounts: value === true })
    if (res.data?.ok) {
      usersSeeAllAccounts.value = res.data.data?.usersSeeAllAccounts === true
      toast.success(usersSeeAllAccounts.value ? '普通用户现已可见全部账号' : '普通用户仅可见自己添加的账号')
    }
    else {
      await rollbackVisibility(value === true)
      toast.error(res.data?.error || '保存失败')
    }
  }
  catch {
    await rollbackVisibility(value === true)
    toast.error('保存失败')
  }
  finally {
    visibilitySaving.value = false
  }
}

// 排行榜数据可见范围：默认全员可见；开启后仅超级管理员可见
const coinRankSuperOnly = ref(false)
const coinRankLoaded = ref(false)
const coinRankSaving = ref(false)

async function loadCoinRankVisibility() {
  try {
    const res = await api.get('/api/admin/coin-rank-visibility')
    if (res.data?.ok)
      coinRankSuperOnly.value = res.data.data?.visibility === 'super_admin'
    coinRankLoaded.value = true
  }
  catch {
    toast.error('读取排行榜可见范围失败')
  }
}

async function rollbackCoinRank(target: boolean) {
  coinRankSuperOnly.value = target
  await nextTick()
  coinRankSuperOnly.value = !target
}

async function toggleCoinRank(value: boolean | undefined) {
  const superOnly = value === true
  if (coinRankSaving.value)
    return
  coinRankSaving.value = true
  try {
    const res = await api.post('/api/admin/coin-rank-visibility', {
      visibility: superOnly ? 'super_admin' : 'all',
    })
    if (res.data?.ok) {
      coinRankSuperOnly.value = res.data.data?.visibility === 'super_admin'
      // 同步本地用户信息，立即驱动菜单与路由权限
      const userStore = useUserStore()
      if (userStore.userInfo)
        userStore.userInfo.coinRankVisibility = res.data.data?.visibility || 'all'
      toast.success(coinRankSuperOnly.value ? '排行榜已设为仅超级管理员可见' : '排行榜已设为全员可见')
    }
    else {
      await rollbackCoinRank(superOnly)
      toast.error(res.data?.error || '保存失败')
    }
  }
  catch {
    await rollbackCoinRank(superOnly)
    toast.error('保存失败')
  }
  finally {
    coinRankSaving.value = false
  }
}

// 免费卡密功能
const freeCardEnabled = ref(false)
const freeCardStock = ref(0)
const freeCardLoaded = ref(false)
const freeCardSaving = ref(false)

async function loadFreeCardStatus() {
  try {
    const res = await api.get('/api/admin/card-claim/status')
    if (res.data?.ok) {
      freeCardEnabled.value = res.data.data?.enabled === true
      freeCardStock.value = Number(res.data.data?.availableTimeCards) || 0
      freeCardLoaded.value = true
    }
  }
  catch {
    toast.error('读取免费卡密开关状态失败')
  }
}

async function rollbackFreeCard(targetEnabled: boolean) {
  freeCardEnabled.value = targetEnabled
  await nextTick()
  freeCardEnabled.value = !targetEnabled
}

async function toggleFreeCard(value: boolean | undefined) {
  const enabled = value === true
  if (freeCardSaving.value)
    return
  freeCardSaving.value = true
  try {
    const res = await api.post('/api/admin/card-claim/status', { enabled, confirmed: true })
    if (res.data?.ok) {
      freeCardEnabled.value = res.data.data?.enabled === true
      freeCardStock.value = Number(res.data.data?.availableTimeCards) || 0
      toast.success(enabled ? '免费卡密功能已开启' : '免费卡密功能已关闭')
    }
    else {
      await rollbackFreeCard(enabled)
      toast.error(res.data?.error || '保存失败')
    }
  }
  catch (error: any) {
    await rollbackFreeCard(enabled)
    toast.error(error?.response?.data?.error || '保存失败')
  }
  finally {
    freeCardSaving.value = false
  }
}

onMounted(() => {
  loadVisibility()
  loadCoinRankVisibility()
  loadFreeCardStatus()
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 普通用户可见全部账号 -->
    <section class="farm-card rounded-lg p-4">
      <div class="mb-1 flex items-center gap-2">
        <div class="i-carbon-user-multiple text-lg" style="color: var(--theme-primary);" />
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          普通用户可见全部账号
        </h4>
      </div>
      <p class="mb-3 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
        开启后普通用户在账号列表可以看到其他用户添加的农场账号（仍然只能操作自己的）。默认关闭：普通用户只能看到自己添加的账号。
      </p>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BaseSwitch
          :model-value="usersSeeAllAccounts"
          label="开启普通用户可见全部账号"
          :disabled="visibilitySaving"
          @update:model-value="toggleVisibility"
        />
        <span v-if="visibilitySaving" class="text-xs text-gray-400">保存中…</span>
        <span v-if="visibilityLoaded" class="text-xs text-gray-500 dark:text-gray-400">{{ usersSeeAllAccounts ? '当前：可见全部账号' : '当前：仅可见自己的账号' }}</span>
      </div>
    </section>

    <!-- 排行榜数据可见范围 -->
    <section class="farm-card rounded-lg p-4">
      <div class="mb-1 flex items-center gap-2">
        <div class="i-carbon-trophy text-lg" style="color: var(--theme-primary);" />
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          排行榜数据可见范围
        </h4>
        <span v-if="!coinRankLoaded" class="text-xs text-gray-400">读取中…</span>
      </div>
      <p class="mb-3 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
        控制「今日金币增加排行榜」对哪些用户开放。默认全员可见，所有登录用户都能查看完整榜单；开启后仅超级管理员可访问，普通用户将看不到入口与数据。该设置独立于账号列表可见性。
      </p>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BaseSwitch
          :model-value="coinRankSuperOnly"
          label="仅超级管理员可见"
          :disabled="coinRankSaving || !coinRankLoaded"
          @update:model-value="toggleCoinRank"
        />
        <span v-if="coinRankSaving" class="text-xs text-gray-400">保存中…</span>
        <span v-if="coinRankLoaded" class="text-xs text-gray-500 dark:text-gray-400">
          当前：<b :class="coinRankSuperOnly ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'">{{ coinRankSuperOnly ? '仅超级管理员可见' : '全员可见' }}</b>
        </span>
      </div>
    </section>

    <!-- 免费卡密功能 -->
    <section class="farm-card rounded-lg p-4">
      <div class="mb-1 flex items-center gap-2">
        <div class="i-carbon-gift text-lg" style="color: var(--theme-primary);" />
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          免费卡密功能
        </h4>
        <span v-if="!freeCardLoaded" class="text-xs text-gray-400">读取中…</span>
      </div>
      <p class="mb-3 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
        开启后，访客可在注册页点击「领取免费卡密」自动获得并填入一张卡密用于注册新账号。只有卡密管理中描述为「免费」的加时卡才可被领取；免费卡密仅可用于注册，不能用于加时长。每个 IP / 浏览器每 24 小时各限领 1 张，领取后锁定 30 分钟，未注册自动释放回库存。
      </p>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BaseSwitch
          :model-value="freeCardEnabled"
          label="开启免费卡密功能"
          :disabled="freeCardSaving || !freeCardLoaded"
          @update:model-value="toggleFreeCard"
        />
        <span v-if="freeCardSaving" class="text-xs text-gray-400">保存中…</span>
        <span v-if="freeCardLoaded" class="text-xs text-gray-500 dark:text-gray-400">
          当前可领取库存：<b :class="freeCardStock > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'">{{ freeCardStock }}</b> 张免费加时卡
        </span>
      </div>
    </section>
  </div>
</template>
