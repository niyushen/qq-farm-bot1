<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { alignRollingDigits, buildRollingDigits, buildRollingSlots, digitGlyph, easeOutCubic, formatRollingNumber, rollDigit } from '@/utils/rolling-number'

/**
 * 逐位滚动的数字：形似老式里程表，每个数位是一个纵向滚动的字轮。
 * 数值变化时逐位滚动到新值；位数增减时补位/截断。
 * 支持正号前缀（+N）、千分位分隔符与小数位。
 */

const props = withDefaults(defineProps<{
  /** 目标数值 */
  value: number | string
  /** 小数位数 */
  decimals?: number
  /** 正数是否带 '+' 前缀 */
  sign?: boolean
  /** 是否启用千分位分隔符 */
  group?: boolean
  /** 单次滚动动画时长（毫秒） */
  duration?: number
}>(), {
  decimals: 0,
  sign: false,
  group: true,
  duration: 900,
})

/** 起始位值 */
const fromDigits = ref<number[]>([])
/** 目标位值 */
const toDigits = ref<number[]>([])
/** 当前插值后的连续位值（可超出 0~9，用于里程表回绕） */
const currentDigits = ref<number[]>([])

let rafId = 0
let startedAt = 0

const options = computed(() => ({
  decimals: props.decimals,
  sign: props.sign,
  group: props.group,
}))

const parts = computed(() => formatRollingNumber(props.value, options.value))

/** 目标位序（高位在前） */
const targetDigits = computed(() => buildRollingDigits(props.value, options.value))

/** 渲染槽位（数字位 + 千分位分隔符） */
const slots = computed(() => buildRollingSlots(props.value, options.value))

/** 渲染用的位序列 */
const displayDigits = computed(() => currentDigits.value.map(value => ({
  glyph: digitGlyph(value),
  offset: value,
})))

/** 供读屏器朗读的文本 */
const spokenText = computed(() => {
  const p = parts.value
  return `${p.sign}${p.integer}${p.fraction ? `.${p.fraction}` : ''}`
})

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia)
    return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function cancelAnimation() {
  if (rafId) {
    window.cancelAnimationFrame(rafId)
    rafId = 0
  }
}

function applyTarget(instant: boolean) {
  const target = targetDigits.value
  if (!target.length) {
    currentDigits.value = []
    fromDigits.value = []
    toDigits.value = []
    return
  }

  // 首次渲染直接落位；降级动效偏好时同样直接落位
  if (!currentDigits.value.length || instant || prefersReducedMotion()) {
    cancelAnimation()
    fromDigits.value = target.slice()
    toDigits.value = target.slice()
    currentDigits.value = target.slice()
    return
  }

  // 位数变化时按高位对齐（多补 0 / 少截高位）
  fromDigits.value = alignRollingDigits(fromDigits.value, target.length)
  toDigits.value = target
  startedAt = 0
  runAnimation()
}

function runAnimation() {
  cancelAnimation()
  const step = (timestamp: number) => {
    if (!startedAt)
      startedAt = timestamp
    const elapsed = timestamp - startedAt
    const ratio = Math.min(1, elapsed / Math.max(1, props.duration))

    const eased = easeOutCubic(ratio)
    currentDigits.value = toDigits.value.map((target, index) => {
      const from = fromDigits.value[index] ?? 0
      return rollDigit(from, target, eased)
    })

    if (ratio < 1) {
      rafId = window.requestAnimationFrame(step)
    }
    else {
      currentDigits.value = toDigits.value.slice()
      rafId = 0
    }
  }
  rafId = window.requestAnimationFrame(step)
}

watch(() => props.value, () => applyTarget(false))

// 初始挂载时直接落位（不做入场滚动），否则字轮会停在 0
onMounted(() => applyTarget(true))

onBeforeUnmount(cancelAnimation)
</script>

<template>
  <span class="rolling-number" :aria-label="spokenText" role="text">
    <span v-if="parts.sign" class="rolling-number__sign">{{ parts.sign }}</span>
    <template v-for="(slot, index) in slots" :key="index">
      <span v-if="slot.type === 'sep'" class="rolling-number__sep">{{ slot.char }}</span>
      <span v-else class="rolling-number__digit" :class="{ 'rolling-number__digit--fraction': slot.isFraction }">
        <span class="rolling-number__wheel" :style="{ '--roll': displayDigits[slot.digitIndex]?.offset ?? 0 }">
          <span class="rolling-number__glyph">0</span>
          <span class="rolling-number__glyph">1</span>
          <span class="rolling-number__glyph">2</span>
          <span class="rolling-number__glyph">3</span>
          <span class="rolling-number__glyph">4</span>
          <span class="rolling-number__glyph">5</span>
          <span class="rolling-number__glyph">6</span>
          <span class="rolling-number__glyph">7</span>
          <span class="rolling-number__glyph">8</span>
          <span class="rolling-number__glyph">9</span>
          <span class="rolling-number__glyph">0</span>
        </span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.rolling-number {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.rolling-number__sign {
  margin-right: 1px;
}

.rolling-number__sep {
  width: 0.3em;
  text-align: center;
}

.rolling-number__digit {
  position: relative;
  display: inline-block;
  overflow: hidden;
  width: 0.62em;
  height: 1em;
  text-align: center;
}

.rolling-number__wheel {
  display: block;
  transform: translateY(calc(var(--roll) * -1em));
  will-change: transform;
}

.rolling-number__glyph {
  display: block;
  height: 1em;
  line-height: 1;
}

.rolling-number__dot {
  margin: 0 0.04em;
}
</style>
