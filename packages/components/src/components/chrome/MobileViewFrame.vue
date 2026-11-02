<script setup lang="ts">
import { X } from "@lucide/vue"
import { useI18n } from "vue-i18n"

defineProps<{
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
}>()
const emit = defineEmits<{ select: []; close: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="mobile-view-frame" :class="{ 'is-preview': preview, 'is-active': active }" :style="{ width: `${sourceWidth}px`, height: `${sourceHeight}px` }">
    <header class="mobile-view-label flex h-8 items-center gap-1" :inert="!preview" :aria-hidden="!preview" :style="{ width: `${sourceWidth * scale}px`, transform: `translate(${x}px, ${y - 32}px)` }">
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ title }}</span>
      <button v-if="closable" type="button" :aria-label="t('mobileViews.close', { title })" :disabled="busy" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ui-text-muted hover:bg-ui-hover" @click="emit('close')"><X :size="14" aria-hidden="true" /></button>
    </header>
    <div data-view-surface class="mobile-view-surface" :style="{ transform: `translate(${x}px, ${y}px) scale(${scale})`, borderRadius: preview && scale > 0 ? `${12 / scale}px` : '0px' }">
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
.mobile-view-label { position: absolute; top: 0; left: 0; opacity: 0; visibility: hidden; transition: opacity 180ms; }
.is-preview .mobile-view-label { opacity: 1; visibility: visible; pointer-events: auto; }
.mobile-view-surface { position: absolute; inset: 0; overflow: hidden; background: var(--ui-color-canvas); transform-origin: top left; transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1); }
.is-active .mobile-view-surface, .is-preview .mobile-view-surface { pointer-events: auto; }
.mobile-view-content { display: flex; flex-direction: column; width: 100%; height: 100%; }
.is-preview .mobile-view-surface { outline: 3px solid var(--ui-color-border); }
.is-preview.is-active .mobile-view-surface { outline: 6px solid var(--ui-color-accent); }
.zooming .mobile-view-surface, .dragging .mobile-view-surface { transition: none; }
@media (prefers-reduced-motion: reduce) { .mobile-view-surface, .mobile-view-label { transition: none; } }
</style>
