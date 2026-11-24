<script setup lang="ts">
import type { GameScene } from '@/stores/scene'
import { storeToRefs } from 'pinia'
import { computed, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SPACE_ENTER_MS, SPACE_LEAVE_MS, spaceTransition } from '@/components/space-transition'
import { getSpaceMenu } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useRanchStore } from '@/stores/ranch'
import { useSceneStore } from '@/stores/scene'

// 给目标页一次短暂的读取机会，较慢的请求继续使用页面自身的加载状态。
const MIN_HOLD_MS = 320
const MAX_HOLD_MS = 1200

const route = useRoute()
const router = useRouter()
const app = useAppStore()
const ranch = useRanchStore()
const sceneStore = useSceneStore()
const { currentAccountId } = storeToRefs(useAccountStore())
const disabled = computed(() => app.spaceSwitching || ranch.busy)

// 与 A 同款：农场 / 牧场两个分段，当前场景高亮，点另一个场景就整站切换。
const SCENE_OPTIONS: Array<{ key: GameScene, label: string, icon: string }> = [
  { key: 'farm', label: '农场', icon: 'i-carbon-sprout' },
  { key: 'ranch', label: '牧场', icon: 'i-carbon-wheat' },
]

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))
const frame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))

function waitUntil(ready: () => boolean, timeout: number) {
  return new Promise<void>((resolve) => {
    if (ready())
      return resolve()
    const timer = window.setTimeout(done, timeout)
    const stop = watch(ready, ok => ok && done())
    function done() {
      window.clearTimeout(timer)
      stop()
      resolve()
    }
  })
}

/** 牧场页等待读取结果；农场页的数据由实时推送补齐，渲染两帧即可。 */
async function waitForDestination(target: GameScene) {
  if (target === 'ranch') {
    await waitUntil(() => !ranch.loading && !ranch.busy && (!!ranch.state || !!ranch.error || !currentAccountId.value), MAX_HOLD_MS)
    return
  }
  await frame()
  await frame()
}

function destinationOf(target: GameScene) {
  const baseName = String(route.name || 'dashboard').replace(/^ranch-/, '')
  const targetName = `${target === 'ranch' ? 'ranch-' : ''}${baseName}`
  const item = getSpaceMenu(target === 'ranch').find(entry => entry.name === targetName)
  return `/${item?.path ?? (target === 'ranch' ? 'ranch' : '')}`
}

async function switchScene(target: GameScene) {
  if (sceneStore.scene === target || disabled.value)
    return
  sceneStore.select(target)
  const destination = destinationOf(target)
  app.spaceSwitching = true
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await router.push(destination)
      await nextTick()
    }
    else {
      spaceTransition.value = { target, phase: 'leave' }
      await sleep(SPACE_LEAVE_MS)
      spaceTransition.value = { target, phase: 'hold' }
      const holdStart = performance.now()
      // 路由失败时照常恢复显示，页面停在原处。
      await router.push(destination).catch(() => undefined)
      await nextTick()
      await waitForDestination(target)
      await sleep(Math.max(0, MIN_HOLD_MS - (performance.now() - holdStart)))
      spaceTransition.value = { target, phase: 'enter' }
      await sleep(SPACE_ENTER_MS)
    }
  }
  finally {
    spaceTransition.value = null
    app.spaceSwitching = false
  }
  await nextTick()
  document.querySelector<HTMLElement>('.page-heading__title')?.focus({ preventScroll: true })
}

// 路由是场景的真值来源：直接点菜单进牧场也要把分段开关切过去。
// 设置页两个场景共用，停在那里时保持进来时的场景，不强行切回农场。
watch(() => route.path, (path) => {
  if (path === '/settings')
    return
  sceneStore.setScene(path.startsWith('/ranch') ? 'ranch' : 'farm')
}, { immediate: true })
</script>

<template>
  <div class="farm-scene-switch" role="group" aria-label="农牧场切换">
    <button
      v-for="option in SCENE_OPTIONS"
      :key="option.key"
      type="button"
      class="farm-scene-option"
      :class="{ 'is-active': sceneStore.scene === option.key }"
      :aria-pressed="sceneStore.scene === option.key"
      :disabled="disabled"
      @click="switchScene(option.key)"
    >
      <span :class="option.icon" aria-hidden="true" />
      <span>{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 桌面：对齐 A 侧栏的方形分段控件。 */
.farm-scene-switch {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--surface-2);
}
.farm-scene-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--muted-text);
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
  transition:
    background 150ms,
    color 150ms;
}
.farm-scene-option > span:first-child {
  font-size: 16px;
}
.farm-scene-option:hover {
  color: var(--theme-text);
}
.farm-scene-option.is-active {
  background: var(--theme-gradient);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--theme-primary) 24%, transparent);
}
.farm-scene-option:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@media (max-width: 1023px) {
  /* 手机：对齐 A 顶栏的胶囊分段控件。 */
  .farm-scene-switch {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-ink) 7%, transparent);
  }
  .farm-scene-option {
    min-height: 0;
    padding: 7px 11px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1;
  }
  .farm-scene-option > span:first-child {
    font-size: 15px;
  }
  .farm-scene-option.is-active {
    background: var(--theme-primary);
    box-shadow: 0 2px 6px color-mix(in srgb, var(--theme-primary) 35%, transparent);
  }
}
</style>
