import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { getApiErrorMessage } from '@/api'
import { useToastStore } from '@/stores/toast'
import App from './App.vue'
import router from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Global Error Handling
const toast = useToastStore()

/**
 * ResizeObserver 的 "loop completed with undelivered notifications" 是浏览器的已知行为：
 * 回调里改动了被观察元素的尺寸，浏览器来不及在同一帧内派发下一轮通知时就会抛这条警告。
 * 它不影响渲染结果，属于无害噪音，不该以错误 toast 的形式打扰用户。
 */
function isResizeObserverNoise(value: unknown): boolean {
  const text = typeof value === 'string' ? value : (value instanceof Error ? value.message : String(value ?? ''))
  return text.includes('ResizeObserver loop')
}

app.config.errorHandler = (err: any, _instance, info) => {
  console.error('全局 Vue 错误:', err, info)
  if (isResizeObserverNoise(err) || isResizeObserverNoise(err?.message))
    return
  const message = getApiErrorMessage(err, String(err))
  toast.error(`应用错误: ${message}`)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (reason && typeof reason === 'object' && 'isAxiosError' in reason)
    return
  if (isResizeObserverNoise(reason) || isResizeObserverNoise(reason?.message))
    return

  console.error('Unhandled Rejection:', reason)
  const message = getApiErrorMessage(reason, String(reason))
  toast.error(`异步错误: ${message}`)
})

window.onerror = (message, _source, _lineno, _colno, error) => {
  // 这条规则必须同时看 message 和 error：Chrome 抛这类警告时 message 是
  // "ResizeObserver loop completed with undelivered notifications."，
  // 而 error 对象可能是 undefined，只判断其中一个会漏掉。
  if (isResizeObserverNoise(message) || isResizeObserverNoise(error))
    return
  if (String(message).includes('Script error'))
    return
  console.error('Global Error:', message, error)
  toast.error(`系统错误: ${getApiErrorMessage(error || message, String(message))}`)
}

app.mount('#app')
