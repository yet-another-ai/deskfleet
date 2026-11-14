<script setup lang="ts">
import { Pipette, RotateCcw, ZoomIn, ZoomOut } from "@lucide/vue"
import { inject, onBeforeUnmount, ref, useTemplateRef, watchEffect } from "vue"
import { useI18n } from "vue-i18n"
import { registerPreviewActionsKey, type PreviewMode } from "../../services/preview.ts"
import { usePanZoom } from "../../composables/usePanZoom.ts"
import ColorPickerLoupe from "./ColorPickerLoupe.vue"

const props = defineProps<{
  src: string
  alt: string
  mode: PreviewMode
}>()

const emit = defineEmits<{ focus: [] }>()
const { t } = useI18n()
const registerActions = inject(registerPreviewActionsKey, undefined)
const image = useTemplateRef<HTMLImageElement>("image")

const { scale, panX, panY, dragging, moved, zoomIn, zoomOut, resetView, startDrag, moveDrag, endDrag } = usePanZoom()
const pickingColor = ref(false)

watchEffect(() => {
  registerActions?.([
    { id: "zoom-in", icon: ZoomIn, label: t("mermaid.zoomIn"), onClick: zoomIn },
    { id: "zoom-out", icon: ZoomOut, label: t("mermaid.zoomOut"), onClick: zoomOut },
    { id: "reset", icon: RotateCcw, label: t("mermaid.resetView"), onClick: resetView },
    { id: "color-picker", icon: Pipette, label: t("mermaid.pickColor"), onClick: () => { pickingColor.value = !pickingColor.value } },
  ])
})

onBeforeUnmount(() => { registerActions?.([]) })

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey && props.mode === "inline") return
  event.preventDefault()
  if (event.deltaY < 0) zoomIn()
  else if (event.deltaY > 0) zoomOut()
}

function focusImage(): void {
  if (props.mode === "inline" && !moved.value) emit("focus")
}
</script>

<template>
  <div
    data-preview-canvas
    class="relative flex min-h-44 flex-1 touch-none items-center justify-center overflow-hidden p-4 pt-11 select-none"
    :class="pickingColor ? 'cursor-crosshair' : dragging ? 'cursor-grabbing' : 'cursor-grab'"
    @pointerdown="startDrag"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @lostpointercapture="endDrag"
    @wheel="onWheel"
  >
    <div
      data-preview-stage
      class="flex h-full w-full items-center justify-center"
      :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }"
    >
      <img ref="image" :src="src" :alt="alt" draggable="false" class="max-h-full max-w-full rounded object-contain select-none" :class="[mode === 'inline' && 'max-h-96', mode === 'inline' && !pickingColor && 'cursor-zoom-in']" @click="focusImage">
    </div>
    <ColorPickerLoupe v-model:open="pickingColor" :media="image" />
  </div>
</template>
