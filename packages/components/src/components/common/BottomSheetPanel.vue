<script setup lang="ts">
import { X } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { DrawerClose, DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerTitle, injectDrawerRootContext } from "reka-ui"
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useSpring } from "../../composables/useSpring.ts"
import UiScrollArea from "./UiScrollArea.vue"

defineProps<{ title: string; background?: "canvas" | "sidebar"; opener: HTMLElement | null }>()
const { t } = useI18n()
const drawer = injectDrawerRootContext()
// Normalized travel lets the first opening animate before layout is measured.
const motion = useSpring(1, { positionThreshold: 0.0005, velocityThreshold: 0.005 })
const position = motion.position
const present = ref(false)
let dragOrigin = 0
let pressTime = 0

watch(drawer.open, open => {
  if (open) present.value = true
  motion.setTarget(open ? 0 : 1)
}, { immediate: true, flush: "sync" })
watch([drawer.open, motion.isActive, motion.isDragging], ([open, active, dragging]) => {
  if (!open && !active && !dragging) present.value = false
})

// Reka retains ownership of scroll-edge arbitration, pointer capture, touch
// cancellation and the dismiss threshold. Only the rendered trajectory is ours.
useEventListener(drawer.contentElement, ["pointerdown", "touchstart"], event => {
  pressTime = event.timeStamp / 1000
}, { capture: true, passive: true })
watch(drawer.isSwiping, swiping => {
  if (swiping) {
    dragOrigin = position.value
    motion.startDrag(pressTime)
  } else {
    motion.endDrag(performance.now() / 1000)
    motion.setTarget(drawer.open.value ? 0 : 1)
  }
}, { flush: "sync" })
useEventListener(drawer.contentElement, ["pointermove", "touchmove"], event => {
  const element = drawer.contentElement.value
  const time = event.timeStamp / 1000
  // Our listener may run before Reka's. Read after all listeners have processed
  // this event, so the first accepted move controls this frame's position.
  queueMicrotask(() => {
    if (!drawer.isSwiping.value || !element || drawer.contentElement.value !== element) return
    const distance = Math.max(1, element.offsetHeight - 48)
    const movement = Number.parseFloat(element.style.getPropertyValue("--drawer-swipe-movement-y")) || 0
    motion.dragTo(dragOrigin + movement / distance, time)
  })
}, { passive: true })

function focusPanel(event: Event): void {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true })
}
</script>

<template>
  <DrawerPortal v-if="present">
    <DrawerOverlay force-mount class="bottom-sheet-overlay fixed inset-0 z-50 bg-ui-scrim backdrop-blur-[3px]" :style="{ opacity: Math.max(0, Math.min(1, 1 - position)) }" />
    <DrawerContent
      force-mount
      :aria-describedby="undefined"
      :final-focus="opener"
      class="bottom-sheet app-no-drag fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full flex-col overflow-hidden rounded-t-3xl shadow-ui-dialog"
      :class="background === 'sidebar' ? 'bg-ui-sidebar' : 'bg-ui-canvas'"
      :style="{ transform: `translateY(calc(${position} * (100% - 48px)))` }"
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
      <UiScrollArea class="min-h-0 flex-1" viewport-class="overscroll-contain" content-class="flex min-h-full flex-col">
        <slot />
      </UiScrollArea>
    </DrawerContent>
  </DrawerPortal>
</template>

<style scoped>
.bottom-sheet {
  --bleed: 48px;
  height: calc(88dvh + var(--bleed));
  max-width: 48rem;
  padding-bottom: calc(var(--safe-area-bottom, env(safe-area-inset-bottom, 0px)) + var(--bleed));
  margin-bottom: calc(-1 * var(--bleed));
  contain: layout paint;
  will-change: transform;
}
.bottom-sheet-overlay { will-change: opacity; }
</style>
