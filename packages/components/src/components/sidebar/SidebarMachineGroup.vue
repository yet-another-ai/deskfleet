<script setup lang="ts">
import { ChevronRight, LocateFixed, Unplug } from "@lucide/vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { machineOrderGroup } from "../../composables/useSidebarOrder.ts"
import MachineBatteryIndicator from "./MachineBatteryIndicator.vue"
import SidebarReorderRow from "./SidebarReorderRow.vue"

export interface SidebarMachineHeaderItem {
  id: string
  name: string
  local: boolean
  online: boolean
  lastSeen?: string
}

const props = defineProps<{
  machine: SidebarMachineHeaderItem
  open: boolean
  reorderItems: readonly { id: string }[]
}>()

const emit = defineEmits<{ "update:open": [value: boolean] }>()
const { t, locale } = useI18n()

const lastSeen = computed(() => {
  if (!props.machine.lastSeen) return undefined
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.machine.lastSeen))
  return t("machine.lastSeen", { time })
})
</script>

<template>
  <CollapsibleRoot
    as="section"
    :data-machine-id="machine.id"
    :open="open"
    class="mt-2 first:mt-0"
    @update:open="emit('update:open', $event)"
  >
    <SidebarReorderRow
      v-slot="{ source }"
      :group="machineOrderGroup"
      :id="machine.id"
      :items="reorderItems"
      class="group flex h-8 items-center rounded-lg pl-2.5 pr-1 ui-motion hover:bg-ui-hover"
    >
      <CollapsibleTrigger
        v-bind="source"
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1 text-left text-[13px] font-medium text-ui-text-muted ui-motion group-hover:text-ui-text"
      >
        <span class="min-w-0 flex-1 truncate">{{ machine.name }}</span>
        <span v-if="machine.local" class="inline-flex shrink-0 items-center text-ui-text-muted" :title="t('machine.local')">
          <LocateFixed :size="13" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ t("machine.local") }}</span>
        </span>
        <span
          v-if="!machine.online"
          class="inline-flex shrink-0 items-center text-ui-warning"
          :title="lastSeen ?? t('machine.offline')"
        >
          <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ t("machine.offline") }}</span>
        </span>
        <MachineBatteryIndicator :machine-id="machine.id" :online="machine.online" />
        <slot name="status" />
      </CollapsibleTrigger>
      <div class="flex shrink-0 items-center gap-0.5">
        <div
          v-if="$slots.actions"
          class="flex shrink-0 items-center text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover:max-w-8 group-hover:op-100 group-hover:pointer-events-auto group-has-[:focus-visible]:max-w-8 group-has-[:focus-visible]:op-100 group-has-[:focus-visible]:pointer-events-auto"
        >
          <slot name="actions" />
        </div>
        <CollapsibleTrigger
          type="button"
          tabindex="-1"
          aria-hidden="true"
          class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
        >
          <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
        </CollapsibleTrigger>
      </div>
    </SidebarReorderRow>
    <slot name="after-header" />

    <CollapsibleContent as="ul" class="m-0 mt-1 flex list-none flex-col gap-1 p-0">
      <slot />
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
