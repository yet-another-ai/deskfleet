<script setup lang="ts">
import { Check, Copy } from "@lucide/vue"
import { onClickOutside, onKeyStroke, useClipboard, useEventListener } from "@vueuse/core"
import { computed, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{ media: HTMLImageElement | HTMLVideoElement | null }>()
const open = defineModel<boolean>("open", { default: false })
const { t } = useI18n()
const { copy, copied } = useClipboard()

interface ColorSample { hex: string; grid: string[]; x: number; y: number }

const pinned = ref(false)
const sample = shallowRef<ColorSample>()
const canvas = computed(() => props.media?.closest<HTMLElement>("[data-preview-canvas]") ?? null)
let scratch: HTMLCanvasElement | undefined
let lastPointer: { x: number; y: number } | undefined

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`

function sampleAt(clientX: number, clientY: number): ColorSample | undefined {
  const media = props.media
  if (!media) return undefined
  const sw = Math.max(1, (media as HTMLVideoElement).videoWidth || (media as HTMLImageElement).naturalWidth || media.clientWidth || 1)
  const sh = Math.max(1, (media as HTMLVideoElement).videoHeight || (media as HTMLImageElement).naturalHeight || media.clientHeight || 1)
  const rect = media.getBoundingClientRect()
  const scale = rect.width > 0 && rect.height > 0 ? Math.min(rect.width / sw, rect.height / sh) : 0
  const width = scale ? sw * scale : sw
  const height = scale ? sh * scale : sh
  const left = scale ? rect.left + (rect.width - width) / 2 : 0
  const top = scale ? rect.top + (rect.height - height) / 2 : 0
  if (scale && (clientX < left || clientX > left + width || clientY < top || clientY > top + height)) return undefined
  const px = Math.min(sw - 1, Math.max(0, Math.floor(((clientX - left) / width) * sw)))
  const py = Math.min(sh - 1, Math.max(0, Math.floor(((clientY - top) / height) * sh)))
  try {
    scratch ??= document.createElement("canvas")
    const ctx = scratch.getContext("2d", { willReadFrequently: true }) ?? scratch.getContext("2d")
    if (!ctx) return undefined
    scratch.width = sw
    scratch.height = sh
    ctx.drawImage(media, 0, 0, sw, sh)
    const sx = Math.max(0, px - 3)
    const sy = Math.max(0, py - 3)
    const pw = Math.min(sw - 1, px + 3) - sx + 1
    const ph = Math.min(sh - 1, py + 3) - sy + 1
    const patch = ctx.getImageData(sx, sy, pw, ph).data
    const cellAt = (x: number, y: number) => {
      const i = (Math.min(ph - 1, Math.max(0, y - sy)) * pw + Math.min(pw - 1, Math.max(0, x - sx))) * 4
      return toHex(patch[i] ?? 0, patch[i + 1] ?? 0, patch[i + 2] ?? 0)
    }
    const grid = Array.from({ length: 49 }, (_, idx) => cellAt(px + (idx % 7) - 3, py + Math.floor(idx / 7) - 3))
    const box = canvas.value?.getBoundingClientRect()
    const rx = box && box.width > 0 ? clientX - box.left : clientX
    const ry = box && box.height > 0 ? clientY - box.top : clientY
    return {
      hex: grid[24]!,
      grid,
      x: box && rx + 116 > box.width ? Math.max(8, rx - 108) : rx + 14,
      y: box && ry + 108 > box.height ? Math.max(8, ry - 100) : ry + 14,
    }
  } catch {
    return undefined
  }
}

function close(): void {
  open.value = false
  pinned.value = false
  sample.value = undefined
  lastPointer = undefined
}

watch(open, value => { if (!value) close() })
watch(() => props.media?.getAttribute("src"), close)

const inLoupe = (event: Event) => Boolean((event.target as Element | null)?.closest?.("[data-color-picker-loupe]"))

useEventListener(canvas, "pointerdown", event => {
  if (open.value && !inLoupe(event)) event.stopImmediatePropagation()
}, { capture: true })

useEventListener(canvas, "pointermove", event => {
  if (!open.value || pinned.value) return
  lastPointer = { x: event.clientX, y: event.clientY }
  sample.value = sampleAt(event.clientX, event.clientY)
})

useEventListener(canvas, "pointerleave", () => {
  if (!pinned.value) sample.value = undefined
})

useEventListener(canvas, "click", event => {
  if (!open.value || inLoupe(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (pinned.value) {
    close()
    return
  }
  const next = sampleAt(event.clientX || lastPointer?.x || 0, event.clientY || lastPointer?.y || 0) ?? sample.value
  if (!next) {
    close()
    return
  }
  sample.value = next
  pinned.value = true
}, { capture: true })

onClickOutside(canvas, event => {
  if (open.value && !(event.target as Element | null)?.closest?.('[data-preview-action="color-picker"]')) close()
})

onKeyStroke("Escape", event => {
  if (!open.value) return
  event.preventDefault()
  close()
})
</script>

<template>
  <div
    v-if="open && sample"
    data-color-picker-loupe
    :data-color-picker-hex="sample.hex"
    :data-pinned="pinned ? 'true' : undefined"
    class="app-no-drag absolute z-20 flex flex-col items-center gap-1 select-none"
    :class="pinned ? 'pointer-events-auto cursor-default' : 'pointer-events-none'"
    :style="{ left: `${sample.x}px`, top: `${sample.y}px` }"
    @pointerdown.stop
    @click.stop
  >
    <div data-color-picker-grid class="grid h-16 w-16 grid-cols-7 grid-rows-7 overflow-hidden rounded-full border-2 border-ui-border-strong bg-ui-canvas shadow-ui-popover">
      <span
        v-for="(cellColor, index) in sample.grid"
        :key="index"
        :data-color-picker-center="index === 24 ? 'true' : undefined"
        :class="index === 24 && 'z-10 ring-1 ring-white outline-1 outline-black/60'"
        :style="{ backgroundColor: cellColor }"
      />
    </div>
    <div class="flex items-center gap-1.5 rounded-md border border-ui-border bg-ui-canvas/95 py-0.5 pr-1 pl-2 font-mono text-[11px] font-medium text-ui-text shadow-ui-card backdrop-blur-xs">
      <span data-color-picker-loupe-swatch class="h-2.5 w-2.5 shrink-0 rounded-full border border-ui-border-strong" :style="{ backgroundColor: sample.hex }" />
      <span>{{ sample.hex }}</span>
      <button
        type="button"
        data-color-picker-copy
        :data-preview-color="sample.hex"
        :data-copied="copied ? 'true' : undefined"
        :aria-label="t(copied ? 'common.copied' : 'common.copyLabel', { label: sample.hex })"
        :title="t(copied ? 'common.copied' : 'common.copyLabel', { label: sample.hex })"
        class="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text active:scale-[0.95]"
        @click.stop="copy(sample.hex)"
      >
        <Check v-if="copied" :size="12" aria-hidden="true" />
        <Copy v-else :size="12" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
