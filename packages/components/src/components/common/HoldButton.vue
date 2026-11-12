<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue"
import { vSpring } from "../../directives/spring.ts"
import { useRafFn } from "@vueuse/core"
import { useSpring } from "../../composables/useSpring.ts"
import UiButton from "./UiButton.vue"

const props = withDefaults(defineProps<{
  text: string
  holdLabel: string
  holdDurationMs?: number
  variant?: "default" | "primary" | "danger" | "ghost"
  disabled?: boolean
}>(), { holdDurationMs: 1200, variant: "default" })
const emit = defineEmits<{ confirm: [] }>()

const showingHold = ref(false)
const textMeasure = useTemplateRef<HTMLElement>("textMeasure")
const holdMeasure = useTemplateRef<HTMLElement>("holdMeasure")
const labelWidth = ref<number>()
let timer: number | undefined
let holdStarted = 0
const progress = useSpring(0, { min: 0, max: 100 })
// The hold deadline remains a clock; only returning from it is spring motion.
const progressFrames = useRafFn(({ timestamp }) => {
  progress.dragTo(Math.min(100, (timestamp - holdStarted) / props.holdDurationMs * 100), timestamp / 1000)
}, { immediate: false })

function updateWidth(showHold: boolean): void {
  showingHold.value = showHold
  labelWidth.value = (showHold ? holdMeasure.value : textMeasure.value)?.offsetWidth || undefined
}
function clearHold(showHold = showingHold.value): void {
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined }
  progressFrames.pause()
  progress.endDrag(performance.now() / 1000)
  progress.setTarget(0)
  updateWidth(showHold)
}
function startHold(event: PointerEvent): void {
  if (event.button !== 0 || props.disabled) return
  clearHold(true)
  holdStarted = performance.now()
  progress.startDrag(holdStarted / 1000)
  progressFrames.resume()
  timer = window.setTimeout(() => { clearHold(false); emit("confirm") }, props.holdDurationMs)
}

onMounted(() => updateWidth(false))
onBeforeUnmount(() => clearHold(false))
</script>

<template>
  <UiButton
    :variant="variant"
    :disabled="disabled"
    class="relative overflow-hidden"
    :aria-label="text"
    @pointerenter="!disabled && updateWidth(true)"
    @pointerdown="startHold"
    @pointerup="clearHold()"
    @pointerleave="clearHold(false)"
    @pointercancel="clearHold(false)"
  >
    <span
      class="pointer-events-none absolute inset-y-0 left-0"
      :class="variant === 'danger' ? 'bg-ui-danger/20' : 'bg-ui-active'"
      :style="{ width: `${progress.position.value}%` }"
      aria-hidden="true"
    />
    <span
      class="relative z-10 inline-block h-5 leading-5 overflow-hidden whitespace-nowrap align-middle"
      v-spring="labelWidth ? { width: `${labelWidth}px` } : {}"
    >
      <span :class="[labelWidth && 'absolute inset-0', 'transition-opacity duration-[var(--ui-duration-fast)]', showingHold ? 'opacity-0' : 'opacity-100']" aria-hidden="true">{{ text }}</span>
      <span class="absolute inset-0 transition-opacity duration-[var(--ui-duration-fast)]" :class="showingHold ? 'opacity-100' : 'opacity-0'" aria-hidden="true">{{ holdLabel }}</span>
      <span ref="textMeasure" class="pointer-events-none invisible absolute whitespace-nowrap" aria-hidden="true">{{ text }}</span>
      <span ref="holdMeasure" class="pointer-events-none invisible absolute whitespace-nowrap" aria-hidden="true">{{ holdLabel }}</span>
    </span>
  </UiButton>
</template>
