<script setup lang="ts">
import { PanelBottomClose } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { WorktreeSummary } from "../../stores/fleet-types.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import IconButton from "../common/IconButton.vue"
import TerminalWorkspace from "./TerminalWorkspace.vue"

/**
 * The Session's own shells, below its conversation. They start in the Session's
 * Worktree, detach when the Session is left, and end when it is deleted.
 */
const props = defineProps<{ worktree: WorktreeSummary }>()
const { t } = useI18n()
const terminals = useTerminalsStore()
const { terminalPanelOpen, terminalPanelHeight } = storeToRefs(useLayoutStore())
const active = computed({
  get: () => {
    const id = terminals.selected[props.worktree.id]
    return props.worktree.terminals.some(terminal => terminal.id === id) ? id : undefined
  },
  set: (id) => {
    if (id) terminals.selected[props.worktree.id] = id
    else delete terminals.selected[props.worktree.id]
  },
})
const minimum = 120
const clamp = (height: number) => Math.round(Math.min(Math.max(height, minimum), window.innerHeight * 0.7))
const height = computed(() => clamp(terminalPanelHeight.value))
const resizing = ref<{ startY: number; startHeight: number } | null>(null)
function startResize(event: PointerEvent): void {
  resizing.value = { startY: event.clientY, startHeight: height.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
useEventListener("pointermove", (event: PointerEvent) => {
  if (resizing.value) terminalPanelHeight.value = clamp(resizing.value.startHeight + resizing.value.startY - event.clientY)
})
useEventListener("pointerup", () => { resizing.value = null })
function keyResize(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16
  if (event.key === "ArrowUp") terminalPanelHeight.value = clamp(height.value + step)
  else if (event.key === "ArrowDown") terminalPanelHeight.value = clamp(height.value - step)
  else return
  event.preventDefault()
}
</script>

<template>
  <section class="relative flex shrink-0 flex-col border-t border-ui-border" :style="{ height: `${height}px` }" :aria-label="t('terminal.sessionPanel')">
    <div
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="t('terminal.resizePanel')"
      :aria-valuenow="height"
      :aria-valuemin="minimum"
      class="absolute inset-x-0 -top-1 h-2 cursor-row-resize hover:bg-ui-focus/40 focus-visible:bg-ui-focus/40"
      :class="resizing && 'bg-ui-focus/40'"
      @pointerdown="startResize"
      @keydown="keyResize"
    />
    <TerminalWorkspace v-model:active-id="active" :terminals="worktree.terminals" :create="() => terminals.create({ worktreeId: worktree.id })">
      <template #actions>
        <IconButton :icon="PanelBottomClose" :label="t('terminal.hidePanel')" @click="terminalPanelOpen = false" />
      </template>
    </TerminalWorkspace>
  </section>
</template>
