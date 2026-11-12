<script setup lang="ts">
import { X } from "@lucide/vue"
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useSpring } from "../../composables/useSpring.ts"

const props = defineProps<{
  title: string
  active: boolean
  preview: boolean
  sourceWidth: number
  sourceHeight: number
  x: number
  y: number
  scale: number
  closable: boolean
  busy: boolean
  direct: boolean
  scrollOrigin: number
}>()
const emit = defineEmits<{ select: []; close: []; motion: [active: boolean] }>()
const { t } = useI18n()
const horizontal = useSpring(props.x, { positionThreshold: 0.3, velocityThreshold: 4 })
const vertical = useSpring(props.y, { positionThreshold: 0.3, velocityThreshold: 4 })
const zoom = useSpring(props.scale, { positionThreshold: 0.0005, velocityThreshold: 0.005 })
const x = horizontal.position
const y = vertical.position
const scale = zoom.position
let previousScrollOrigin = props.scrollOrigin

watch(() => [props.x, props.y, props.scale, props.direct, props.scrollOrigin] as const, () => {
  // Programmatic overview scrolling changes the coordinate origin. Rebase the
  // current position, preserving its on-screen location and its velocity.
  vertical.rebase(props.scrollOrigin - previousScrollOrigin)
  previousScrollOrigin = props.scrollOrigin
  if (props.direct) {
    horizontal.jump(props.x)
    vertical.jump(props.y)
    zoom.jump(props.scale)
  } else {
    horizontal.setTarget(props.x)
    vertical.setTarget(props.y)
    zoom.setTarget(props.scale)
  }
})
const moving = computed(() => horizontal.isActive.value || vertical.isActive.value || zoom.isActive.value)
watch(moving, active => emit("motion", active), { flush: "sync" })
</script>

<template>
  <section class="mobile-view-frame" :class="{ 'is-preview': preview, 'is-active': active }" :style="{ width: `${sourceWidth}px`, height: `${sourceHeight}px` }">
    <header class="mobile-view-label flex h-8 items-center gap-1" :inert="!preview" :aria-hidden="!preview" :style="{ width: `${sourceWidth * scale}px`, transform: `translate3d(${x}px, ${y - 32}px, 0)` }">
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ title }}</span>
      <button v-if="closable" type="button" :aria-label="t('mobileViews.close', { title })" :disabled="busy" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ui-text-muted hover:bg-ui-hover" @click="emit('close')"><X :size="14" aria-hidden="true" /></button>
    </header>
    <div data-view-surface class="mobile-view-surface" :style="{ transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`, borderRadius: preview && scale > 0 ? `${12 / scale}px` : '0px' }">
      <div class="mobile-view-content" :inert="preview || !active" :aria-hidden="preview || !active">
        <slot />
      </div>
      <button v-if="preview" type="button" class="absolute inset-0 cursor-pointer rounded-[inherit] focus-visible:outline-2 focus-visible:outline-ui-accent" :aria-label="title" :aria-current="active ? 'true' : undefined" @click="emit('select')" />
    </div>
  </section>
</template>

<style scoped>
.mobile-view-frame { position: absolute; top: 0; left: 0; pointer-events: none; }
.mobile-view-frame.is-active { z-index: 1; }
.mobile-view-label { position: absolute; top: 0; left: 0; opacity: 0; visibility: hidden; will-change: transform, opacity; transition: opacity 180ms; }
.is-preview .mobile-view-label { opacity: 1; visibility: visible; pointer-events: auto; }
.mobile-view-surface { position: absolute; inset: 0; overflow: hidden; contain: layout paint; will-change: transform; backface-visibility: hidden; background: var(--ui-color-canvas); transform-origin: top left; }
.is-active .mobile-view-surface, .is-preview .mobile-view-surface { pointer-events: auto; }
.mobile-view-content { display: flex; flex-direction: column; width: 100%; height: 100%; }
.is-preview .mobile-view-surface { outline: 3px solid var(--ui-color-border); }
.is-preview.is-active .mobile-view-surface { outline: 6px solid var(--ui-color-accent); }
@media (prefers-reduced-motion: reduce) { .mobile-view-label { transition: none; } }
</style>
