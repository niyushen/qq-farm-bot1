import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface Account {
  id: string
  name: string
  nick?: string
  uin?: number
  avatar?: string
  platform?: string
  running?: boolean
  /** 账号运行时状态（登录中/重登等待/运行中/离线等），由后端实时下发 */
  runtimeState?: 'logging_in' | 'relogin_waiting' | 'running' | 'offline' | 'stopping' | 'stopped'
  reloginAt?: number | null
  // 归属：创建/绑定该账号的登录用户名（owner 优先，兼容旧数据回落 username）
  owner?: string
  username?: string
  // Add other fields as discovered
}

export interface AccountLog {
  time: string
  action: string
  msg: string
  reason?: string
}

export function getPlatformLabel(p?: string) {
  if (p === 'qq')
    return 'QQ'
  if (p === 'wx')
    return '微信'
  return ''
}

export function getPlatformClass(p?: string) {
  if (p === 'qq')
    return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
  if (p === 'wx')
    return 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
  return ''
}

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = useStorage('current_account_id', '')
  const loading = ref(false)
  const logs = ref<AccountLog[]>([])
  let accountsRequestSequence = 0

  /**
   * 重新登录请求：概览页「一键重连」发现授权已失效时发出，
   * 由侧边栏统一弹出登录弹窗——避免页面和侧边栏各挂一个弹窗互相遮挡。
   */
  const reloginRequest = ref<{ accountId: string, nonce: number }>({ accountId: '', nonce: 0 })

  const currentAccount = computed(() =>
    accounts.value.find(a => String(a.id) === currentAccountId.value),
  )

  function requestRelogin(accountId: string) {
    reloginRequest.value = { accountId: String(accountId || ''), nonce: reloginRequest.value.nonce + 1 }
  }

  async function fetchAccounts() {
    const sequence = ++accountsRequestSequence
    loading.value = true
    try {
      // api interceptor adds x-admin-token
      const res = await api.get('/api/accounts')
      if (sequence !== accountsRequestSequence)
        return
      if (res.data.ok && res.data.data && res.data.data.accounts) {
        accounts.value = res.data.data.accounts

        // Auto-select first account if none selected or selected not found
        if (accounts.value.length > 0) {
          const found = accounts.value.find(a => String(a.id) === currentAccountId.value)
          if (!found && accounts.value[0]) {
            currentAccountId.value = String(accounts.value[0].id)
          }
        }
        else {
          // 如果账号列表为空，清空当前选中的账号ID
          currentAccountId.value = ''
        }
      }
      else {
        // 如果返回数据无效，也清空账号列表和选中状态
        accounts.value = []
        currentAccountId.value = ''
      }
    }
    catch (e) {
      console.error('获取账号失败', e)
      if (sequence !== accountsRequestSequence)
        return
      // 请求失败时也清空状态
      accounts.value = []
      currentAccountId.value = ''
    }
    finally {
      if (sequence === accountsRequestSequence)
        loading.value = false
    }
  }

  function selectAccount(id: string) {
    currentAccountId.value = id
  }

  function setCurrentAccount(acc: Account) {
    selectAccount(acc.id)
  }

  function syncAccountAvatar(id: string, avatar: string) {
    const account = accounts.value.find(item => String(item.id) === String(id))
    if (account && avatar) {
      account.avatar = avatar
    }
  }

  async function startAccount(id: string) {
    await api.post(`/api/accounts/${id}/start`)
    await fetchAccounts()
  }

  async function stopAccount(id: string) {
    await api.post(`/api/accounts/${id}/stop`)
    await fetchAccounts()
  }

  async function deleteAccount(id: string) {
    await api.delete(`/api/accounts/${id}`)
    if (currentAccountId.value === id) {
      currentAccountId.value = ''
    }
    await fetchAccounts()
  }

  async function fetchLogs() {
    try {
      const res = await api.get('/api/account-logs?limit=100')
      if (Array.isArray(res.data)) {
        logs.value = res.data
      }
    }
    catch (e) {
      console.error('获取账号日志失败', e)
    }
  }

  async function addAccount(payload: any) {
    try {
      await api.post('/api/accounts', payload)
      await fetchAccounts()
    }
    catch (e) {
      console.error('添加账号失败', e)
      throw e
    }
  }

  async function updateAccount(id: string, payload: any) {
    try {
      // core uses POST /api/accounts for both add and update (if id is present)
      await api.post('/api/accounts', { ...payload, id })
      await fetchAccounts()
    }
    catch (e) {
      console.error('更新账号失败', e)
      throw e
    }
  }

  /** 续期全部微信账号授权。后端提供 /api/accounts/refresh-wx-credentials；失败时返回明确错误对象供 UI 提示。 */
  async function refreshWxCodes() {
    try {
      const res = await api.post('/api/accounts/refresh-wx-credentials')
      await fetchAccounts()
      return res.data
    }
    catch (e: any) {
      const message = e?.response?.data?.error || e?.message || '当前版本不支持微信授权续期'
      return { ok: false, error: message, success: 0, failed: 0, skipped: 0, results: [] }
    }
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    loading,
    logs,
    reloginRequest,
    requestRelogin,
    fetchAccounts,
    selectAccount,
    startAccount,
    stopAccount,
    deleteAccount,
    fetchLogs,
    addAccount,
    updateAccount,
    refreshWxCodes,
    setCurrentAccount,
    syncAccountAvatar,
  }
})
