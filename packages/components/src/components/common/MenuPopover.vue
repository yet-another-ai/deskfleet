<script setup lang="ts">
import { onClickOutside } from "@vueuse/core"
import { nextTick, ref, useId, useTemplateRef } from "vue"

defineProps<{ label: string; disabled?: boolean; placement?: "top" | "bottom" }>()
const root = useTemplateRef<HTMLElement>("root")
const trigger = useTemplateRef<HTMLButtonElement>("trigger")
const menu = useTemplateRef<HTMLElement>("menu")
const id = useId()
const open = ref(false)
const items = () => [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
function close(restoreFocus = true): void {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}
async function expand(last = false): Promise<void> {
  open.value = true
  await nextTick()
  const buttons = items()
  buttons[last ? buttons.length - 1 : 0]?.focus()
}
function move(event: KeyboardEvent): void {
  if (event.key === "Tab") { close(); return }
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const buttons = items()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}
onClickOutside(root, () => close(false))
</script>

<template>
  <div ref="root" class="app-no-drag relative min-w-0">
    <button ref="trigger" type="button" class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-ui-hover disabled:cursor-default disabled:op-50" :aria-label="label" aria-haspopup="menu" :aria-expanded="open" :aria-controls="id" :disabled="disabled" @click="open ? close() : expand()" @keydown.down.prevent="expand()" @keydown.up.prevent="expand(true)">
      <slot name="trigger" />
    </button>
    <div v-if="open" :id="id" ref="menu" role="menu" :aria-label="label" class="ui-menu absolute left-0 z-50 max-h-[70vh] w-full min-w-56 overflow-y-auto" :class="placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-1'" @keydown="move">
      <slot :close="close" />
    </div>
  </div>
</template>
