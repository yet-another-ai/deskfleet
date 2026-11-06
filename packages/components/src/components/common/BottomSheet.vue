<script setup lang="ts">
import { X } from "@lucide/vue"
import { DrawerClose, DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle } from "reka-ui"
import { shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{ open: boolean; title: string; background?: "canvas" | "sidebar" }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const opener = shallowRef<HTMLElement | null>(null)
watch(() => props.open, open => {
  if (open) opener.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
}, { immediate: true, flush: "sync" })

function focusPanel(event: Event): void {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true })
}
</script>

<template>
  <DrawerRoot :open="open" swipe-direction="down" @update:open="!$event && emit('close')">
    <DrawerPortal>
      <DrawerOverlay class="bottom-sheet-overlay fixed inset-0 z-50 bg-ui-scrim backdrop-blur-[3px]" />
      <DrawerContent
        :aria-describedby="undefined"
        :final-focus="opener"
        class="bottom-sheet app-no-drag fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full flex-col overflow-hidden rounded-t-3xl shadow-ui-dialog"
        :class="background === 'sidebar' ? 'bg-ui-sidebar' : 'bg-ui-canvas'"
        @open-auto-focus="focusPanel"
      >
        <div class="flex shrink-0 justify-center py-3">
          <DrawerHandle class="h-1 w-10 rounded-full bg-ui-text-faint/40" />
        </div>
        <header class="flex shrink-0 items-center gap-3 px-4 pb-3">
          <DrawerTitle class="min-w-0 flex-1 truncate text-base font-medium">{{ title }}</DrawerTitle>
          <DrawerClose :aria-label="t('common.close')" class="flex h-10 w-10 items-center justify-center rounded-full bg-ui-hover text-ui-text-muted">
            <X :size="18" aria-hidden="true" />
          </DrawerClose>
        </header>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <slot />
        </div>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
</template>

<style scoped>
.bottom-sheet {
  --bleed: 48px;
  --sheet-ease: cubic-bezier(0.32, 0.72, 0, 1);
  height: calc(88dvh + var(--bleed));
  max-width: 48rem;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--bleed));
  margin-bottom: calc(-1 * var(--bleed));
  contain: layout paint;
  will-change: transform, translate;
  transform: translateY(var(--drawer-swipe-movement-y, 0px));
  transition: transform 500ms var(--sheet-ease);
}
.bottom-sheet[data-state="open"] { animation: sheet-in 500ms var(--sheet-ease); }
.bottom-sheet[data-state="closed"] { animation: sheet-out calc(500ms * var(--drawer-swipe-strength, 1)) var(--sheet-ease) forwards; }
.bottom-sheet[data-swiping] { transition-duration: 0ms; }
.bottom-sheet-overlay { will-change: opacity; }
.bottom-sheet-overlay[data-state="open"] { animation: overlay-in 500ms var(--sheet-ease); }
.bottom-sheet-overlay[data-state="closed"] { animation: overlay-out calc(500ms * var(--drawer-swipe-strength, 1)) var(--sheet-ease) forwards; }
@keyframes sheet-in { from { translate: 0 calc(100% - var(--bleed)); } }
@keyframes sheet-out { to { translate: 0 calc(100% - var(--bleed)); } }
@keyframes overlay-in { from { opacity: 0; } }
@keyframes overlay-out { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .bottom-sheet, .bottom-sheet-overlay { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
</style>
