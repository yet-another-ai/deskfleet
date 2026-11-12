<script setup lang="ts">
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable"
import { Check, ChevronRight } from "@lucide/vue"
import { DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "reka-ui"
import { computed } from "vue"
import UiScrollArea from "../common/UiScrollArea.vue"

const props = defineProps<{ option: SessionConfigOption; open: boolean; disabled?: boolean }>()
const emit = defineEmits<{ "update:open": [value: boolean]; change: [value: string | boolean] }>()
const groups = computed(() => props.option.type === "select" ? props.option.options.map(row => "group" in row
  ? { id: row.group, name: row.name, options: row.options }
  : { id: row.value, options: [row], name: undefined }) : [])
const currentName = computed(() => groups.value.flatMap(group => group.options).find(row => row.value === props.option.currentValue)?.name ?? props.option.currentValue)
function choose(value: string): void {
  emit("update:open", false)
  emit("change", value)
}
</script>

<template>
  <DropdownMenuCheckboxItem v-if="option.type === 'boolean'" as="button" type="button" :model-value="option.currentValue" :disabled="disabled" :data-agent-config-id="option.id" :data-config-category="option.category" class="ui-menu-item gap-3 focus:outline-none" @select.prevent="emit('change', !option.currentValue)">
    <span class="min-w-0 flex-1 text-left">
      <span class="block">{{ option.name }}</span>
      <span v-if="option.description" class="mt-0.5 block whitespace-normal text-xs text-ui-text-muted">{{ option.description }}</span>
    </span>
    <span class="flex size-4 shrink-0 items-center justify-center rounded border border-ui-border" :class="option.currentValue && 'border-ui-accent bg-ui-accent text-white'">
      <Check v-if="option.currentValue" :size="12" aria-hidden="true" />
    </span>
  </DropdownMenuCheckboxItem>
  <DropdownMenuSub v-else :open="open" @update:open="emit('update:open', $event)">
    <DropdownMenuSubTrigger as="button" type="button" :data-agent-config-id="option.id" :data-config-category="option.category" :data-value="option.currentValue" :disabled="disabled || !groups.length" class="ui-menu-item gap-3 focus:outline-none" :class="open && 'bg-ui-hover'">
      <span class="min-w-0 flex-1 text-left">
        <span class="block">{{ option.name }}</span>
        <span v-if="option.description" class="mt-0.5 block whitespace-normal text-xs text-ui-text-muted">{{ option.description }}</span>
      </span>
      <span class="ml-auto max-w-28 truncate text-ui-text-muted">{{ currentName }}</span>
      <ChevronRight :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent :aria-label="option.name" :side-offset="4" :collision-padding="8" class="ui-menu z-50 flex max-h-[min(20rem,var(--reka-popper-available-height))] min-w-48 max-w-[min(20rem,calc(100vw-16px))] flex-col overflow-hidden p-0" loop>
        <UiScrollArea :focusable="false" fade-size="sm" class="min-h-0 flex-auto" content-class="p-1">
          <DropdownMenuRadioGroup :model-value="String(option.currentValue)">
            <template v-for="group in groups" :key="group.id">
              <DropdownMenuLabel v-if="group.name" class="px-2.5 py-1.5 text-xs font-medium text-ui-text-muted">{{ group.name }}</DropdownMenuLabel>
              <DropdownMenuRadioItem v-for="choice in group.options" :key="choice.value" as="button" type="button" :value="choice.value" :data-value="choice.value" :disabled="disabled" class="ui-menu-item focus:outline-none" @select.prevent="choose(choice.value)">
                <span class="min-w-0 flex-1 text-left">
                  <span class="block" :class="choice.description ? 'whitespace-normal' : 'truncate'">{{ choice.name }}</span>
                  <span v-if="choice.description" class="mt-0.5 block whitespace-normal text-xs text-ui-text-muted">{{ choice.description }}</span>
                </span>
                <Check v-if="option.currentValue === choice.value" :size="15" class="shrink-0" aria-hidden="true" />
              </DropdownMenuRadioItem>
            </template>
          </DropdownMenuRadioGroup>
        </UiScrollArea>
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>
</template>
