<script setup lang="ts">
import { DrawerRoot } from "reka-ui"
import { shallowRef, watch } from "vue"
import BottomSheetPanel from "./BottomSheetPanel.vue"

const props = defineProps<{ open: boolean; title: string; background?: "canvas" | "sidebar" }>()
const emit = defineEmits<{ close: [] }>()
const opener = shallowRef<HTMLElement | null>(null)
watch(() => props.open, open => {
  if (!open) return
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // Reopening an in-flight exit keeps the original outside focus destination.
  if (!active?.closest(".bottom-sheet")) opener.value = active
}, { immediate: true, flush: "sync" })
</script>

<template>
  <DrawerRoot :open="open" swipe-direction="down" @update:open="!$event && emit('close')">
    <BottomSheetPanel :title="title" :background="background" :opener="opener"><slot /></BottomSheetPanel>
  </DrawerRoot>
</template>
