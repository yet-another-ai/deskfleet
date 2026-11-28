<script setup lang="ts">
import SpringSurface from "../common/SpringSurface.ts"
import { Eye, EyeOff } from "@lucide/vue"
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from "reka-ui"
import { computed, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  machineId: string
  name: string
  showingHidden: boolean
  hasHiddenWorkspaces: boolean
}>()
const emit = defineEmits<{ toggleHidden: [] }>()
const { t } = useI18n()
const row = useTemplateRef<HTMLElement>("row")
const open = ref(false)
const cursor = ref<{ x: number; y: number }>()

/** Virtual anchor so a sync open still places the menu at the pointer, not the viewport origin. */
const pointerReference = computed(() => {
  if (!cursor.value) return
  const { x, y } = cursor.value
  return {
    getBoundingClientRect: () => ({
      width: 0,
      height: 0,
      top: y,
      right: x,
      bottom: y,
      left: x,
      x,
      y,
      toJSON: () => ({}),
    }),
  }
})

watch(open, value => { if (!value) cursor.value = undefined })

function focusRow(): void {
  row.value?.querySelector<HTMLElement>("button, a")?.focus()
}
/**
 * Open without Reka's async contextmenu path so Electron cannot show a native menu first.
 * Record the pointer so Content can anchor at the click instead of Reka's unused {0,0} virtual point.
 */
function openMenu(event: Event): void {
  event.preventDefault()
  cursor.value = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined
  open.value = true
}
function keyboardOpen(event: KeyboardEvent): void {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
  openMenu(event)
}
function closeFocus(event: Event): void {
  event.preventDefault()
  focusRow()
}
function toggleHidden(): void {
  if (!props.showingHidden && !props.hasHiddenWorkspaces) return
  open.value = false
  emit("toggleHidden")
}

defineExpose({ cursor, pointerReference })
</script>

<template>
  <ContextMenuRoot v-model:open="open" :modal="false">
    <ContextMenuTrigger as="div" @contextmenu="openMenu" @keydown="keyboardOpen">
      <div ref="row">
        <slot />
      </div>
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent :as="SpringSurface" :reference="pointerReference" :aria-label="name" :collision-padding="8" class="ui-menu z-50 flex min-w-48 flex-col" loop @close-auto-focus="closeFocus">
        <ContextMenuItem
          as="button"
          type="button"
          class="ui-menu-item whitespace-nowrap"
          data-machine-action="toggle-hidden-workspaces"
          :data-machine-id="machineId"
          :disabled="!showingHidden && !hasHiddenWorkspaces"
          @select="toggleHidden"
        >
          <component :is="showingHidden ? EyeOff : Eye" :size="14" aria-hidden="true" />
          {{ t(showingHidden ? "machine.hideHiddenWorkspaces" : "machine.showHiddenWorkspaces") }}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
