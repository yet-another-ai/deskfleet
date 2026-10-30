<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue"
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
const holding = ref(false)
const textMeasure = useTemplateRef<HTMLElement>("textMeasure")
const holdMeasure = useTemplateRef<HTMLElement>("holdMeasure")
const labelWidth = ref<number>()
let timer: number | undefined

function updateWidth(showHold: boolean): void {
  showingHold.value = showHold
  labelWidth.value = (showHold ? holdMeasure.value : textMeasure.value)?.offsetWidth || undefined
}
function clearHold(showHold = showingHold.value): void {
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined }
  holding.value = false
  updateWidth(showHold)
}
function startHold(event: PointerEvent): void {
  if (event.button !== 0 || props.disabled) return
  clearHold(true)
  holding.value = true
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
      :style="{ width: holding ? '100%' : '0%', transition: holding ? `width ${holdDurationMs}ms linear` : 'width 200ms ease-out' }"
      aria-hidden="true"
    />
    <span
      class="relative z-10 inline-block h-5 leading-5 overflow-hidden whitespace-nowrap align-middle transition-[width] duration-200 ease-out"
      :style="labelWidth ? { width: `${labelWidth}px` } : undefined"
    >
      <span :class="[labelWidth && 'absolute inset-0', 'transition-opacity duration-150', showingHold ? 'opacity-0' : 'opacity-100']" aria-hidden="true">{{ text }}</span>
      <span class="absolute inset-0 transition-opacity duration-150" :class="showingHold ? 'opacity-100' : 'opacity-0'" aria-hidden="true">{{ holdLabel }}</span>
      <span ref="textMeasure" class="pointer-events-none invisible absolute whitespace-nowrap" aria-hidden="true">{{ text }}</span>
      <span ref="holdMeasure" class="pointer-events-none invisible absolute whitespace-nowrap" aria-hidden="true">{{ holdLabel }}</span>
    </span>
  </UiButton>
</template>
