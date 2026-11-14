<script setup lang="ts">
import SpringSurface from "./SpringSurface.ts"
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"
import { ref, watch } from "vue"
import { useSpring } from "../../composables/useSpring.ts"

defineOptions({ inheritAttrs: false })
const props = defineProps<{ preventClose?: boolean; title?: string; described?: boolean }>()
const open = defineModel<boolean>("open", { default: true })
/** Emitted after the exit settles; callers can then remove their dialog data. */
const emit = defineEmits<{ close: []; openAutoFocus: [event: Event] }>()
const motion = useSpring(0, { positionThreshold: 0.001, velocityThreshold: 0.005 })
const progress = motion.position
const present = ref(false)
let opener: HTMLElement | null = null
watch(open, value => {
  if (value) {
    // Reversing an exit keeps the original outside focus destination.
    if (!present.value) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    present.value = true
  }
  motion.setTarget(value ? 1 : 0)
}, { immediate: true, flush: "sync" })
watch([open, motion.isActive], ([value, active]) => {
  if (value || active || !present.value) return
  present.value = false
  emit("close")
})

// Completion handlers may close while their own pending flag is still true.
// User dismissal is guarded by changeOpen and disabled consumer controls.
function close(): void { open.value = false }
defineExpose({ close })

function changeOpen(value: boolean): void {
  if (!value && props.preventClose) return
  open.value = value
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
}
</script>

<template>
  <!-- Reka owns focus and dismissal until the visible spring exit completes. -->
  <DialogRoot :open="present" @update:open="changeOpen">
    <DialogPortal v-if="present">
      <DialogOverlay force-mount class="ui-dialog-overlay" :style="{ opacity: Math.max(0, Math.min(1, progress)) }" />
      <DialogContent :as="SpringSurface" motion="none" force-mount
        class="ui-dialog ui-dialog-content app-no-drag"
        v-bind="{ ...(!described && { 'aria-describedby': undefined }), ...$attrs }"
        :style="{ opacity: Math.max(0, Math.min(1, progress)), scale: 0.98 + 0.02 * progress }"
        :inert="!open"
        @escape-key-down="(!open || preventClose) && $event.preventDefault()"
        @pointer-down-outside.prevent
        @open-auto-focus="emit('openAutoFocus', $event)"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle v-if="title" class="sr-only">{{ title }}</DialogTitle>
        <slot :close="close" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
/* Scrim and panel share the same spring; color and blur live in styles.css. */
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
}
.ui-dialog-content {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 50;
  max-height: calc(100dvh - 2rem);
  overflow-y: auto;
  transform: translate(-50%, -50%);
}
</style>
