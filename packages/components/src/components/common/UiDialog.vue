<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"
import { watch } from "vue"

defineOptions({ inheritAttrs: false })
const props = defineProps<{ preventClose?: boolean; title?: string; described?: boolean }>()
const open = defineModel<boolean>("open", { default: true })
const emit = defineEmits<{ close: []; openAutoFocus: [event: Event] }>()
let opener: HTMLElement | null = null
watch(open, value => {
  if (value) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
}, { immediate: true, flush: "sync" })

function changeOpen(value: boolean): void {
  if (!value && props.preventClose) return
  open.value = value
  if (!value) emit("close")
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="changeOpen">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay" />
      <DialogContent
        class="ui-dialog ui-dialog-content app-no-drag"
        v-bind="{ ...(!described && { 'aria-describedby': undefined }), ...$attrs }"
        @escape-key-down="preventClose && $event.preventDefault()"
        @pointer-down-outside.prevent
        @open-auto-focus="emit('openAutoFocus', $event)"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle v-if="title" class="sr-only">{{ title }}</DialogTitle>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgb(12 14 20 / 45%);
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
