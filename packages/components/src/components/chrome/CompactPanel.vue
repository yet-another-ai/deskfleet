<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"

defineProps<{ side: "left" | "right"; title: string }>()
const emit = defineEmits<{ close: [] }>()
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
function focusPanel(event: Event): void {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.focus()
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/45" />
      <DialogContent
        :aria-describedby="undefined"
        class="app-no-drag fixed inset-y-0 z-50 w-[min(24rem,calc(100vw-2rem))] bg-ui-canvas shadow-ui-dialog"
        :class="side === 'left' ? 'left-0' : 'right-0'"
        @open-auto-focus="focusPanel"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="sr-only">{{ title }}</DialogTitle>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
