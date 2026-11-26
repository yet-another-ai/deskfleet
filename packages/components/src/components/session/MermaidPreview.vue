<script setup lang="ts">
import { Check, Copy, RotateCcw, ZoomIn, ZoomOut } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { getActivePinia } from "pinia"
import { computed, inject, onBeforeUnmount, ref, watchEffect } from "vue"
import { useI18n } from "vue-i18n"
import { usePanZoom } from "../../composables/usePanZoom.ts"
import { renderMermaidDiagram } from "../../services/mermaid.ts"
import { registerPreviewActionsKey, type PreviewMode } from "../../services/preview.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = withDefaults(defineProps<{
  code: string
  mode?: PreviewMode
  loading?: boolean
}>(), {
  mode: "inline",
  loading: false,
})

const { t } = useI18n()
const appearance = getActivePinia() ? useAppearanceStore() : undefined
const isDark = computed(() => appearance?.isDark ?? false)
const registerActions = inject(registerPreviewActionsKey, undefined)
const svg = ref<string>()
const copied = ref(false)
const { scale, panX, panY, dragging, zoomIn, zoomOut, resetView, startDrag, moveDrag, endDrag } = usePanZoom()
let generation = 0
let disposed = false
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function triggerRender(code: string, dark: boolean, isStreaming: boolean, version: number): void {
  const trimmed = code.trim()
  if (!trimmed) {
    svg.value = undefined
    return
  }
  void renderMermaidDiagram(trimmed, dark)
    .then(rendered => { if (!disposed && version === generation) svg.value = rendered })
    .catch(() => {
      // During streaming, keep the last valid SVG instead of flashing back to <pre><code> on incomplete syntax.
      if (!disposed && version === generation && !isStreaming) svg.value = undefined
    })
}

watchImmediate([() => props.code, isDark, () => props.loading], ([code, dark, isStreaming]) => {
  const version = ++generation
  clearTimeout(debounceTimer)
  if (!code.trim()) {
    svg.value = undefined
    return
  }
  if (isStreaming) {
    debounceTimer = setTimeout(() => {
      if (!disposed && version === generation) triggerRender(code, dark, true, version)
    }, 120)
  } else {
    triggerRender(code, dark, false, version)
  }
})

async function copyCode(): Promise<void> {
  try { await navigator.clipboard.writeText(props.code) } catch { return }
  clearTimeout(copiedTimer)
  copied.value = true
  copiedTimer = setTimeout(() => { if (!disposed) copied.value = false }, 1500)
}

watchEffect(() => {
  registerActions?.(svg.value
    ? [
        { id: "zoom-in", icon: ZoomIn, label: t("mermaid.zoomIn"), onClick: zoomIn },
        { id: "zoom-out", icon: ZoomOut, label: t("mermaid.zoomOut"), onClick: zoomOut },
        { id: "reset", icon: RotateCcw, label: t("mermaid.resetView"), onClick: resetView },
        { id: "copy", icon: copied.value ? Check : Copy, label: t(copied.value ? "common.copied" : "common.copy"), onClick: () => { void copyCode() } },
      ]
    : [])
})

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey && props.mode === "inline") return
  event.preventDefault()
  if (event.deltaY < 0) zoomIn()
  else if (event.deltaY > 0) zoomOut()
}

onBeforeUnmount(() => {
  disposed = true
  ++generation
  clearTimeout(copiedTimer)
  clearTimeout(debounceTimer)
  registerActions?.([])
})
</script>

<template>
  <div
    v-if="svg"
    data-mermaid-canvas
    class="flex min-h-44 flex-1 touch-none items-center justify-center overflow-hidden p-4 select-none"
    :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
    @pointerdown="startDrag"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @lostpointercapture="endDrag"
    @wheel="onWheel"
  >
    <div
      data-mermaid-stage
      class="flex w-full items-center justify-center"
      :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }"
      v-html="svg"
    />
  </div>
  <UiScrollArea v-else orientation="horizontal" fade-size="sm">
    <pre class="!m-0 !overflow-visible !border-0 p-3"><code>{{ code }}</code></pre>
  </UiScrollArea>
</template>
