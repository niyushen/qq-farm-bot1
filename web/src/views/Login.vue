<script setup lang="ts">
import type { ApiResult } from '@/stores/user'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BrandMark from '@/components/ui/BrandMark.vue'
import LoginRenewModal from '@/components/LoginRenewModal.vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

declare const __APP_VERSION__: string

type TabKey = 'login' | 'register' | 'reset'

const userStore = useUserStore()
const toast = useToastStore()
const appVersion = __APP_VERSION__
const gameVersion = ref('')
const wxGameVersion = ref('')

const tab = ref<TabKey>('login')
const loading = ref(false)
const showRenew = ref(false)
const lockoutRemaining = ref(0)
const rateLimitRemaining = ref(0)
const errorMessage = ref('')

// 登录
const username = ref('')
const password = ref('')

// 注册
const registerForm = ref({ username: '', password: '', confirm: '', cardCode: '', inviteCode: '' })
const invitePreview = ref<{ valid: boolean, inviteeDays?: number, inviterDays?: number, reason?: string } | null>(null)
const checkingInvite = ref(false)
const invitePreviewText = computed(() => {
  const reason = invitePreview.value?.reason || ''
  if (reason === 'disabled')
    return '管理员暂未开启邀请奖励，邀请码先留着'
  if (reason === 'code_not_found')
    return '邀请码不存在，请核对后重填（不填也能注册）'
  return '邀请码无效，不填也能注册'
})
const cardPreview = ref<{ ok: boolean, error?: string, data?: any } | null>(null)
const checkingCard = ref(false)
const claimingCard = ref(false)

// 找回密码
const resetStep = ref<1 | 2>(1)
const resetForm = ref({ username: '', cardCode: '', newPassword: '' })

const tabs: { key: TabKey, label: string }[] = [
  { key: 'login', label: '登录' },
  { key: 'register', label: '注册' },
  { key: 'reset', label: '找回密码' },
]

const usernameValid = computed(() => {
  const name = tab.value === 'login' ? username.value : registerForm.value.username
  if (!name)
    return { valid: false, message: '' }
  if (name.length < 3)
    return { valid: false, message: '用户名至少3位' }
  if (name.length > 32)
    return { valid: false, message: '用户名最多32位' }
  if (!/^\w+$/.test(name))
    return { valid: false, message: '只能包含字母、数字、下划线' }
  return { valid: true, message: '' }
})

const passwordMismatch = computed(
  () => registerForm.value.confirm.length > 0
    && registerForm.value.password !== registerForm.value.confirm,
)

const canSubmit = computed(() => {
  if (loading.value)
    return false
  if (tab.value === 'login')
    return !!username.value && !!password.value
  if (tab.value === 'register') {
    return !!registerForm.value.username
      && !!registerForm.value.password
      && !passwordMismatch.value
      && !!registerForm.value.cardCode
  }
  return !!resetForm.value.username && !!resetForm.value.cardCode
    && (resetStep.value === 1 || !!resetForm.value.newPassword)
})

const submitLabel = computed(() => {
  if (tab.value === 'login')
    return '登录'
  if (tab.value === 'register')
    return '注册并激活'
  return resetStep.value === 1 ? '验证身份' : '重置密码'
})

function showResult(result: ApiResult | undefined, fallback: string, okMessage?: string) {
  if (result?.ok) {
    if (okMessage)
      toast.success(okMessage)
    return true
  }
  toast.error(result?.error || fallback)
  return false
}

function handleAuthError(data: any, fallback: string) {
  if (data?.errorType === 'rate_limit') {
    errorMessage.value = data.error || fallback
    if (data.remainingMs)
      rateLimitRemaining.value = Math.ceil(data.remainingMs / 1000)
    return
  }
  if (data?.errorType === 'locked') {
    errorMessage.value = data.error || '账户已被锁定'
    if (data.remainingMs)
      lockoutRemaining.value = Math.ceil(data.remainingMs / 1000 / 60)
    return
  }
  errorMessage.value = data?.error || fallback
}

async function handleLogin() {
  if (!canSubmit.value)
    return

  loading.value = true
  errorMessage.value = ''

  try {
    const result = await userStore.login(username.value, password.value)
    if (result.ok) {
      toast.success('登录成功')
      await userStore.fetchUserInfo()
      setTimeout(() => {
        window.location.href = '/'
      }, 500)
      return
    }
    handleAuthError(result, '登录失败')
  }
  catch (e: any) {
    handleAuthError(e.response?.data, '操作异常')
  }
  finally {
    loading.value = false
  }
}

let cardPreviewTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCardPreview() {
  cardPreview.value = null
  if (cardPreviewTimer)
    clearTimeout(cardPreviewTimer)
  const code = registerForm.value.cardCode.trim()
  if (code.length < 4)
    return
  cardPreviewTimer = setTimeout(async () => {
    checkingCard.value = true
    try {
      cardPreview.value = await userStore.peekCard(code)
    }
    finally {
      checkingCard.value = false
    }
  }, 400)
}

let invitePreviewTimer: ReturnType<typeof setTimeout> | null = null

function scheduleInvitePreview() {
  invitePreview.value = null
  if (invitePreviewTimer)
    clearTimeout(invitePreviewTimer)
  const code = registerForm.value.inviteCode.trim()
  if (code.length < 4)
    return
  invitePreviewTimer = setTimeout(async () => {
    checkingInvite.value = true
    try {
      const res = await api.get('/api/public/invite/preview', { params: { code }, skipErrorToast: true })
      invitePreview.value = res.data?.data || null
    }
    catch {
      invitePreview.value = { valid: false, reason: 'network' }
    }
    finally {
      checkingInvite.value = false
    }
  }, 400)
}

async function handleClaimFreeCard() {
  if (claimingCard.value)
    return
  claimingCard.value = true
  try {
    const result = await userStore.claimFreeCard()
    if (!result?.ok) {
      toast.error(result?.error || '领取失败，请稍后重试')
      return
    }
    registerForm.value.cardCode = result.cardCode || ''
    scheduleCardPreview()
    toast.success(`已领取免费卡密（${result.valueText || '加时卡'}），已自动填入，请直接注册`)
  }
  finally {
    claimingCard.value = false
  }
}

async function handleRegister() {
  if (!canSubmit.value)
    return
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await userStore.register(
      registerForm.value.username,
      registerForm.value.password,
      registerForm.value.cardCode.trim(),
      registerForm.value.inviteCode.trim(),
    )
    if (!showResult(result, '注册失败'))
      return
    toast.success('注册成功，请使用账号密码登录')
    username.value = registerForm.value.username
    password.value = ''
    registerForm.value = { username: '', password: '', confirm: '', cardCode: '', inviteCode: '' }
    cardPreview.value = null
    invitePreview.value = null
    tab.value = 'login'
  }
  finally {
    loading.value = false
  }
}

async function handleReset() {
  if (!canSubmit.value)
    return
  loading.value = true
  errorMessage.value = ''
  try {
    if (resetStep.value === 1) {
      const result = await userStore.verifyResetPassword(resetForm.value.username, resetForm.value.cardCode)
      if (showResult(result, '验证失败')) {
        toast.success('验证通过，请设置新密码')
        resetStep.value = 2
      }
      return
    }
    const result = await userStore.resetPassword(
      resetForm.value.username,
      resetForm.value.cardCode,
      resetForm.value.newPassword,
    )
    if (!showResult(result, '重置失败'))
      return
    toast.success('密码重置成功，请重新登录')
    resetStep.value = 1
    resetForm.value = { username: '', cardCode: '', newPassword: '' }
    tab.value = 'login'
  }
  finally {
    loading.value = false
  }
}

function submit() {
  if (tab.value === 'login')
    return handleLogin()
  if (tab.value === 'register')
    return handleRegister()
  return handleReset()
}

function switchTab(next: TabKey) {
  tab.value = next
  resetStep.value = 1
  errorMessage.value = ''
}

/** 登录页续费成功后，把账号回填到登录框，方便直接登录 */
function handleRenewDone(renewedUsername: string) {
  if (!renewedUsername)
    return
  username.value = renewedUsername
  password.value = ''
  tab.value = 'login'
}

async function fetchGameVersion() {
  try {
    const res = await api.get('/api/game-version', { skipErrorToast: true })
    if (res.data.ok)
      gameVersion.value = res.data.clientVersion
    wxGameVersion.value = res.data.wxClientVersion || ''
  }
  catch (e) {
    console.error('获取游戏版本失败:', e)
  }
}

onMounted(fetchGameVersion)
</script>

<template>
  <main class="login-container">
    <section class="login-card">
      <header class="logo-area">
        <BrandMark class="logo-icon" :size="58" />
        <div>
          <span class="logo-kicker">QQ FARM</span>
          <h1 class="logo-title">
            科技偷菜
          </h1>
          <p class="logo-subtitle">
            {{ tab === 'register' ? '创建账号 · 卡密激活' : tab === 'reset' ? '找回密码' : '欢迎回来，开启智慧农耕之旅' }}
          </p>
        </div>
      </header>

      <!-- Tab 切换 -->
      <nav class="tab-bar" aria-label="登录页切换">
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          class="tab-item"
          :class="{ active: tab === item.key }"
          @click="switchTab(item.key)"
        >
          {{ item.label }}
        </button>
      </nav>

      <form class="form-area" @submit.prevent="submit">
        <!-- 登录 -->
        <template v-if="tab === 'login'">
          <div class="form-group">
            <label class="form-label" for="username">
              <span class="i-carbon-user" />
              用户名
            </label>
            <BaseInput
              id="username"
              v-model="username"
              type="text"
              placeholder="请输入用户名"
              autocomplete="username"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="password">
              <span class="i-carbon-locked" />
              密码
            </label>
            <BaseInput
              id="password"
              v-model="password"
              type="password"
              placeholder="请输入密码"
              autocomplete="current-password"
              required
            />
          </div>
        </template>

        <!-- 注册 -->
        <template v-else-if="tab === 'register'">
          <div class="form-group">
            <label class="form-label" for="reg-username">
              <span class="i-carbon-user" />
              用户名
            </label>
            <BaseInput
              id="reg-username"
              v-model="registerForm.username"
              type="text"
              placeholder="3-32 位字母/数字/下划线"
              autocomplete="username"
              required
            />
            <p v-if="registerForm.username && !usernameValid.valid" class="form-hint error">
              {{ usernameValid.message }}
            </p>
          </div>

          <div class="form-group">
            <label class="form-label" for="reg-password">
              <span class="i-carbon-locked" />
              密码
            </label>
            <BaseInput
              id="reg-password"
              v-model="registerForm.password"
              type="password"
              placeholder="至少 6 位"
              autocomplete="new-password"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="reg-confirm">
              <span class="i-carbon-locked" />
              确认密码
            </label>
            <BaseInput
              id="reg-confirm"
              v-model="registerForm.confirm"
              type="password"
              placeholder="再次输入密码"
              autocomplete="new-password"
              :style="passwordMismatch ? { borderColor: 'var(--ui-danger)' } : undefined"
              required
            />
            <p v-if="passwordMismatch" class="form-hint error">
              两次输入的密码不一致
            </p>
          </div>

          <div class="form-group">
            <div class="label-row">
              <label class="form-label" for="reg-card">
                <span class="i-carbon-ticket" />
                卡密（决定账号有效期）
              </label>
              <button
                type="button"
                class="link-btn"
                :disabled="claimingCard"
                @click="handleClaimFreeCard"
              >
                <span :class="claimingCard ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-gift'" />
                {{ claimingCard ? '领取中…' : '领取免费卡密' }}
              </button>
            </div>
            <BaseInput
              id="reg-card"
              v-model="registerForm.cardCode"
              type="text"
              placeholder="例如 XXXX-XXXX-XXXX-XXXX"
              class="font-mono"
              required
              @input="scheduleCardPreview"
            />
            <div v-if="checkingCard" class="form-hint">
              正在校验卡密…
            </div>
            <div v-else-if="cardPreview" class="form-hint" :class="cardPreview.ok ? 'ok' : 'error'">
              <span :class="cardPreview.ok ? 'i-carbon-checkmark-filled' : 'i-carbon-warning-filled'" />
              <span v-if="cardPreview.ok">
                {{ cardPreview.data?.type === 'quota' ? `额度卡 · +${cardPreview.data?.value} 个账号` : `加时卡 · ${cardPreview.data?.isPermanent ? '永久' : `${cardPreview.data?.durationValue}${cardPreview.data?.durationUnit === 'hour' ? ' 小时' : ' 天'}`}` }}
              </span>
              <span v-else>{{ cardPreview.error }}</span>
            </div>
          </div>

          <div class="form-group">
            <div class="label-row">
              <label class="form-label" for="reg-invite">
                <span class="i-carbon-user-follow" />
                邀请码（可选）
              </label>
              <span class="label-extra">不填也能注册</span>
            </div>
            <BaseInput
              id="reg-invite"
              v-model="registerForm.inviteCode"
              type="text"
              placeholder="有朋友邀请你，就填他的邀请码"
              class="font-mono"
              @input="scheduleInvitePreview"
            />
            <div v-if="checkingInvite" class="form-hint">
              正在校验邀请码…
            </div>
            <div v-else-if="invitePreview" class="form-hint" :class="invitePreview.valid ? 'ok' : 'error'">
              <span :class="invitePreview.valid ? 'i-carbon-checkmark-filled' : 'i-carbon-warning-filled'" />
              <span v-if="invitePreview.valid">
                有效 · 绑定挂机账号后双方各得：你 {{ invitePreview.inviteeDays }} 天、邀请人 {{ invitePreview.inviterDays }} 天
              </span>
              <span v-else>{{ invitePreviewText }}</span>
            </div>
          </div>
        </template>

        <!-- 找回密码 -->
        <template v-else>
          <div class="form-group">
            <label class="form-label" for="reset-username">
              <span class="i-carbon-user" />
              用户名
            </label>
            <BaseInput
              id="reset-username"
              v-model="resetForm.username"
              type="text"
              placeholder="请输入用户名"
              autocomplete="username"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="reset-card">
              <span class="i-carbon-ticket" />
              曾用卡密（用于验证身份）
            </label>
            <BaseInput
              id="reset-card"
              v-model="resetForm.cardCode"
              type="text"
              placeholder="例如 XXXX-XXXX-XXXX-XXXX"
              class="font-mono"
              required
            />
          </div>

          <div v-if="resetStep === 2" class="form-group">
            <label class="form-label" for="reset-password">
              <span class="i-carbon-locked" />
              新密码
            </label>
            <BaseInput
              id="reset-password"
              v-model="resetForm.newPassword"
              type="password"
              placeholder="至少 6 位"
              autocomplete="new-password"
              required
            />
          </div>
        </template>

        <div v-if="errorMessage" class="message error-message" role="alert">
          <span class="i-carbon-warning-alt" />
          <div>
            {{ errorMessage }}
            <span v-if="lockoutRemaining > 0">（{{ lockoutRemaining }} 分钟后解锁）</span>
            <span v-if="rateLimitRemaining > 0">（{{ rateLimitRemaining }} 秒后可重试）</span>
          </div>
        </div>

        <BaseButton type="submit" variant="primary" block :loading="loading" class="submit-btn">
          <span v-if="!loading" class="inline-flex items-center gap-2">
            <span :class="tab === 'login' ? 'i-carbon-login' : 'i-carbon-checkmark'" />
            {{ submitLabel }}
          </span>
        </BaseButton>
      </form>

      <div class="quick-area">
        <div class="quick-divider">
          <span>快捷入口</span>
        </div>
        <div class="quick-grid">
          <button type="button" class="quick-entry" @click="showRenew = true">
            <span class="i-carbon-renew" />
            <span>账号续费</span>
          </button>
        </div>
        <p v-if="tab === 'login'" class="switch-hint">
          还没有账号？
          <button type="button" class="link-btn" @click="switchTab('register')">
            立即注册
          </button>
        </p>
        <p v-else class="switch-hint">
          已有账号？
          <button type="button" class="link-btn" @click="switchTab('login')">
            返回登录
          </button>
        </p>
      </div>

      <footer class="card-footer">
        <div class="footer-info">
          <span>Web v{{ appVersion }}</span>
          <span v-if="gameVersion">QQ {{ gameVersion }}</span>
          <span v-if="wxGameVersion">微信 {{ wxGameVersion }}</span>
        </div>
      </footer>
    </section>

    <LoginRenewModal
      :show="showRenew"
      :default-username="username"
      @close="showRenew = false"
      @done="handleRenewDone"
    />
  </main>
</template>

<style scoped>
.login-container {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: 28px 18px;
  color: var(--ui-ink);
  background-color: var(--ui-bg);
  background-image:
    linear-gradient(rgba(67, 141, 99, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(67, 141, 99, 0.045) 1px, transparent 1px);
  background-size: 42px 42px;
}

.login-container::before {
  position: absolute;
  inset: 8% 7%;
  border: 1px solid rgba(67, 141, 99, 0.08);
  border-radius: 36px;
  background: color-mix(in srgb, var(--ui-surface-strong) 22%, transparent);
  content: '';
}

.login-card {
  position: relative;
  z-index: 1;
  width: min(430px, 100%);
  padding: 30px;
  border: 1px solid var(--ui-border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--ui-bg) 82%, transparent);
  box-shadow:
    0 28px 76px rgba(55, 75, 61, 0.16),
    inset 0 1px 0 var(--glass-highlight);
  -webkit-backdrop-filter: blur(24px) saturate(135%);
  backdrop-filter: blur(24px) saturate(135%);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--ui-border);
}

.logo-icon {
  flex: none;
  filter: drop-shadow(0 8px 18px rgba(45, 122, 83, 0.24));
}

.logo-kicker {
  color: var(--ui-primary);
  font-size: 10px;
  font-weight: var(--fw-700);
}

.logo-title {
  margin: 2px 0 0;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}

.logo-subtitle {
  margin: 5px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 14px;
  border-bottom: 1px solid var(--ui-border);
}

.tab-item {
  position: relative;
  padding: 8px 12px 10px;
  border: none;
  background: transparent;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: var(--fw-600);
  cursor: pointer;
  transition: color 0.2s ease;
}

.tab-item:hover {
  color: var(--ui-ink);
}

.tab-item.active {
  color: var(--ui-primary);
}

.tab-item.active::after {
  position: absolute;
  right: 8px;
  bottom: -1px;
  left: 8px;
  height: 2px;
  border-radius: 2px;
  background: var(--ui-primary);
  content: '';
}

.form-area {
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding-top: 18px;
}

.form-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.label-extra {
  color: var(--ui-subtle);
  font-size: 11px;
}

.form-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.form-label > span {
  color: var(--ui-primary);
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.link-btn:hover {
  opacity: 0.8;
}

.link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-card :deep(.base-input) {
  height: 42px;
  border-color: var(--ui-border);
  border-radius: 10px;
  color: var(--ui-ink);
  background: color-mix(in srgb, var(--ui-surface-strong) 70%, transparent);
}

.login-card :deep(.base-input:focus) {
  border-color: rgba(67, 141, 99, 0.55);
  box-shadow: 0 0 0 3px rgba(67, 141, 99, 0.1);
}

.form-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: var(--ui-subtle);
  font-size: 11px;
}

.form-hint.error {
  color: var(--ui-danger);
}

.form-hint.ok {
  color: var(--ui-primary);
}

.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.error-message {
  border-color: rgba(201, 95, 102, 0.18);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.submit-btn {
  margin-top: 2px;
}

.quick-area {
  margin-top: 20px;
}

.quick-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ui-subtle);
  font-size: 11px;
}

.quick-divider::before,
.quick-divider::after {
  flex: 1;
  height: 1px;
  background: var(--ui-border);
  content: '';
}

.quick-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  margin-top: 12px;
}

.quick-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-surface-strong) 55%, transparent);
  color: var(--ui-muted);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-entry > span:first-child {
  color: var(--ui-primary);
  font-size: 18px;
}

.quick-entry:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 35%, transparent);
  background: var(--ui-surface-strong);
  color: var(--ui-primary);
  transform: translateY(-1px);
}

.switch-hint {
  margin: 14px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  text-align: center;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-subtle);
  font-size: 10px;
}

.footer-info {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

@media (max-width: 480px) {
  .login-container {
    align-items: center;
    padding: 16px 12px;
  }

  .login-container::before {
    inset: 4%;
    border-radius: 24px;
  }

  .login-card {
    padding: 24px 20px;
    border-radius: 16px;
  }

  .logo-icon {
    width: 52px;
    height: 52px;
  }

  .logo-title {
    font-size: 19px;
  }
}
</style>
