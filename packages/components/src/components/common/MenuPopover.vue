<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { ref, useTemplateRef } from "vue"

defineProps<{ label: string; disabled?: boolean; placement?: "top" | "bottom" }>()
const open = ref(false)
const trigger = useTemplateRef<InstanceType<typeof DropdownMenuTrigger>>("trigger")
const openingDialog = ref(false)
function changeOpen(value: boolean): void {
  open.value = value
  if (value) openingDialog.value = false
}
function openDialog(show: () => void): void {
  // A menu item disappears on selection. Let the dialog capture its durable trigger.
  openingDialog.value = true
  open.value = false
  const button = trigger.value?.$el as HTMLButtonElement | undefined
  button?.focus()
  show()
}
</script>

<template>
  <div class="app-no-drag min-w-0">
    <DropdownMenuRoot :open="open" :modal="false" @update:open="changeOpen">
      <DropdownMenuTrigger ref="trigger" class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-ui-hover disabled:cursor-default disabled:op-50" :aria-label="label" :disabled="disabled">
        <slot name="trigger" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent :aria-label="label" :side="placement ?? 'bottom'" align="start" :side-offset="4" :collision-padding="8" class="ui-menu z-50 max-h-[var(--reka-dropdown-menu-content-available-height)] min-w-56 w-[var(--reka-dropdown-menu-trigger-width)] overflow-y-auto" loop @close-auto-focus="openingDialog && $event.preventDefault()" @interact-outside="openingDialog && $event.preventDefault()">
          <slot :close="() => { open = false }" :open-dialog="openDialog" />
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
