import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useAppUpdateStore } from '@/stores/app-update'
import { useUserStore } from '@/stores/user'
import { allMenuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

type TokenCheckResult = 'valid' | 'unauthorized' | 'unavailable'

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<TokenCheckResult> | null = null

async function ensureTokenValid(): Promise<TokenCheckResult> {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return 'unauthorized'

  if (validatedToken && validatedToken === token)
    return 'valid'

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res): TokenCheckResult => {
    const ok = !!(res.data && res.data.ok)
    if (ok) {
      validatedToken = token
      // validate 返回最新角色，同步进本地用户信息（避免本地缓存角色过期导致误判）
      const role = res.data?.data?.role
      const coinRankVisibility = res.data?.data?.coinRankVisibility
      if (role || coinRankVisibility) {
        try {
          const userStore = useUserStore()
          if (userStore.userInfo) {
            if (role && userStore.userInfo.role !== role)
              userStore.userInfo.role = role
            if (coinRankVisibility)
              userStore.userInfo.coinRankVisibility = coinRankVisibility
          }
        }
        catch {
          // pinia 尚未激活时忽略（守卫内会再取一次）
        }
      }
      // 上游 PR #182：后端可达，用于在线更新的前后端存活探测
      useAppUpdateStore().notifyBackendReachable()
      return 'valid'
    }
    return 'unauthorized'
  }).catch((err: any): TokenCheckResult => {
    const status = Number(err?.response?.status || 0)
    if (status === 401 || status === 403)
      return 'unauthorized'
    useAppUpdateStore().notifyBackendUnavailable()
    return 'unavailable'
  }).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: allMenuRoutes.map(route => ({
        path: route.path,
        name: route.name,
        component: route.component,
        meta: route.meta,
      })),
    },
    {
      path: '/mystery-shop',
      name: 'mystery-shop',
      redirect: to => ({ name: 'game-mall', query: { ...to.query, tab: 'mystery' }, hash: to.hash }),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
  ],
})

router.beforeEach(async (to, _from) => {
  NProgress.start()

  if (to.name === 'login') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const result = await ensureTokenValid()
    if (result === 'valid')
      return { name: 'dashboard' }
    if (result === 'unauthorized') {
      adminToken.value = ''
      validatedToken = ''
    }
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const result = await ensureTokenValid()
  if (result === 'unauthorized') {
    adminToken.value = ''
    validatedToken = ''
    return { name: 'login' }
  }

  // 角色隔离：superOnly 页面仅超级管理员可访问，越权回概览
  if (to.meta?.superOnly) {
    try {
      const userStore = useUserStore()
      if (!userStore.isSuperAdmin)
        return { name: 'dashboard' }
    }
    catch {
      return { name: 'dashboard' }
    }
  }

  // 排行榜可见范围：管理员在后台设为「仅超级管理员」时，普通用户越权回概览
  // 农场侧（coin-rank）与牧场侧（ranch-coin-rank）共用同一份数据，受同一开关约束。
  if (to.name === 'coin-rank' || to.name === 'ranch-coin-rank') {
    try {
      const userStore = useUserStore()
      if (!userStore.canViewCoinRank)
        return { name: 'dashboard' }
    }
    catch {
      return { name: 'dashboard' }
    }
  }

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
