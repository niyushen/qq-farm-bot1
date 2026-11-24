<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AnnouncementPopup from '@/components/AnnouncementPopup.vue'
import MobileBottomNav from '@/components/MobileBottomNav.vue'
import PageHeader from '@/components/PageHeader.vue'
import Sidebar from '@/components/Sidebar.vue'
import { SPACE_TRANSITION_STYLE, spaceTransition } from '@/components/space-transition'
import SpaceTransition from '@/components/SpaceTransition.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const route = useRoute()
const { sidebarOpen, activityDetailOpen } = storeToRefs(appStore)
// 页头固定在滚动区之外；活动详情自带标题栏，打开时隐藏通用页头。
const activityDetail = computed(() => ['activity-center', 'ranch-activity-center'].includes(String(route.name)) && activityDetailOpen.value)
const showPageHeader = computed(() => !route.meta.fullBleed && !activityDetail.value)
const scrolled = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
const pageTabsTarget = ref<HTMLElement | null>(null)
provide('page-tabs-target', pageTabsTarget)

/** 上次写入的滚动条宽度，用于跳过无意义的重复写入。 */
let lastScrollbarWidth = -1
/** 延迟写入 CSS 变量的帧句柄。 */
let scrollbarFrame = 0

function measureScrollbar() {
  const el = scrollEl.value
  if (!el)
    return
  // 页头右边缘与滚动区对齐：经典滚动条占位时让出它的宽度，悬浮滚动条（手机）为 0。
  const width = Math.max(0, el.offsetWidth - el.clientWidth)
  // 值没变就别动 DOM：写同样的 margin 仍可能让浏览器重新排版，
  // 在 ResizeObserver 回调里就形成 "loop completed with undelivered notifications"。
  if (width === lastScrollbarWidth)
    return
  lastScrollbarWidth = width
  // 改父元素 margin 会影响滚动区宽度，进而再次触发观察回调；
  // 放到下一帧执行，避开同一帧内的布局通知循环。
  window.cancelAnimationFrame(scrollbarFrame)
  scrollbarFrame = window.requestAnimationFrame(() => {
    scrollbarFrame = 0
    el.parentElement?.style.setProperty('--scrollbar-w', `${width}px`)
  })
}

function onPageScroll(event: Event) {
  scrolled.value = (event.target as HTMLElement).scrollTop > 2
}

watch(() => route.fullPath, async () => {
  scrolled.value = false
  await nextTick()
  scrollEl.value?.scrollTo({ top: 0 })
  measureScrollbar()
}, { immediate: true })
useResizeObserver(scrollEl, measureScrollbar)

onBeforeUnmount(() => {
  // 布局销毁后别让排队的 rAF 回调再去操作已卸载的 DOM。
  if (scrollbarFrame)
    window.cancelAnimationFrame(scrollbarFrame)
  scrollbarFrame = 0
})
</script>

<template>
  <div
    class="liquid-layout w-screen flex overflow-hidden"
    :data-space-phase="spaceTransition?.phase"
    :style="SPACE_TRANSITION_STYLE"
    :inert="!!spaceTransition"
  >
    <div
      v-if="sidebarOpen"
      class="navigation-overlay fixed inset-0 z-40 lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="app-main relative h-full min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <div class="app-content min-h-0 flex flex-1 flex-col overflow-hidden" :class="{ 'is-scrolled': scrolled }">
        <div v-if="showPageHeader" class="page-header-bar">
          <div class="page-header-content">
            <PageHeader />
            <div ref="pageTabsTarget" class="page-tabs-host" />
          </div>
        </div>
        <div
          ref="scrollEl"
          class="page-scroll custom-scrollbar flex flex-1 flex-col"
          :class="[
            route.meta.fullBleed ? 'overflow-hidden p-0' : 'overflow-y-auto',
            { 'page-scroll--fill': activityDetail },
          ]"
          @scroll.passive="onPageScroll"
        >
          <RouterView v-slot="{ Component, route: currentRoute }">
            <div :key="currentRoute.path" class="page-view min-h-0 min-w-0 w-full flex flex-1 flex-col">
              <component :is="Component" />
            </div>
          </RouterView>
        </div>
      </div>
    </main>

    <MobileBottomNav v-if="!route.meta.fullBleed" />
    <SpaceTransition />
    <AnnouncementPopup />
  </div>
</template>

<style scoped>
.liquid-layout {
  height: 100dvh;
}

@media (prefers-reduced-motion: no-preference) {
  .page-view {
    animation: page-arrive 160ms ease-out;
  }
}
@keyframes page-arrive {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.navigation-overlay {
  background: rgba(30, 39, 32, 0.32);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

/* 页头和内容共用左右留白，顶栏透出页面原有的渐变背景。 */
.app-content {
  --page-pad: clamp(16px, 2.4vw, 34px);
  --sticky-top: 0px;
}

.page-header-bar {
  position: relative;
  z-index: 20;
  flex-shrink: 0;
  margin-right: var(--scrollbar-w, 0px);
  padding: 16px var(--page-pad) 12px;
  background: transparent;
}

.page-header-content {
  width: 100%;
  max-width: 1580px;
  margin-inline: auto;
}

.page-header-bar:has(.page-tabs) {
  padding-bottom: 0;
}

.page-tabs-host:empty {
  display: none;
}

.page-scroll {
  position: relative;
  z-index: 0;
  min-height: 0;
  padding: 0 var(--page-pad) 28px;
  isolation: isolate;
}

.page-scroll > :deep(*) {
  flex: 0 0 auto;
  width: 100%;
  max-width: 1580px;
  margin-block-start: 16px;
  margin-inline: auto;
}

/* 活动详情隐藏通用页头；普通详情沿用页面滚动，游戏外壳保留内部滚动。 */
.page-scroll--fill > :deep(*) {
  margin-block-start: 0;
  flex: 1 1 auto;
  min-height: 0;
}

.page-scroll--fill :deep(.activity-shell) {
  flex: 1 1 auto;
  min-height: 0;
}

@media (max-width: 1023px) {
  .app-content {
    --page-pad: 12px;
  }

  .page-header-bar {
    padding-top: 12px;
  }

  .page-scroll {
    /* 底部导航是悬浮的，留出它的高度，最后一张卡片和按钮不会被挡住。 */
    padding: 0 var(--page-pad) calc(104px + env(safe-area-inset-bottom));
    scroll-padding-bottom: calc(104px + env(safe-area-inset-bottom));
  }

  .page-scroll:not(.page-scroll--fill) > :deep(*) {
    margin-block-start: 14px;
  }
}

@media (max-width: 480px) {
  .app-content {
    --page-pad: 8px;
  }
}
</style>
