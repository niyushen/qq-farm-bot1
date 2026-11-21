import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { allMenuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<boolean> | null = null

async function ensureTokenValid() {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return false

  if (validatedToken && validatedToken === token)
    return true

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res) => {
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
    }
    return ok
  }).catch(() => false).finally(() => {
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
    const valid = await ensureTokenValid()
    if (valid)
      return { name: 'dashboard' }
    adminToken.value = ''
    validatedToken = ''
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const valid = await ensureTokenValid()
  if (!valid) {
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
  if (to.name === 'coin-rank') {
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
