<script setup lang="ts">
import { ChevronRight, LocateFixed, Unplug } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { Machine } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"

defineProps<{ machine: Machine }>()
const emit = defineEmits<{ select: [] }>()
const { t } = useI18n()
const session = useAccountSession()
</script>

<template>
  <!-- Another Team machine, drawn like a collapsed machine group; opening it switches machines. -->
  <section class="mt-4 first:mt-0">
    <button
      type="button"
      class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg pr-2 pl-2.5 text-left text-[13px] font-medium text-ui-text-muted hover:bg-ui-hover hover:text-ui-text"
      :aria-label="t('account.openMachine', { name: machine.name })"
      :data-machine-id="machine.id"
      @click="emit('select')"
    >
      <span class="truncate">{{ machine.name }}</span>
      <span v-if="machine.id === session?.localMachineId.value" class="inline-flex shrink-0 items-center text-ui-text-muted" :title="t('machine.local')">
        <LocateFixed :size="14" :stroke-width="1.75" aria-hidden="true" />
        <span class="sr-only">{{ t("machine.local") }}</span>
      </span>
      <span v-if="!machine.online" class="inline-flex shrink-0 items-center text-ui-warning" :title="t('machine.offline')">
        <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />
        <span class="sr-only">{{ t("machine.offline") }}</span>
      </span>
      <ChevronRight :size="14" class="shrink-0" aria-hidden="true" />
    </button>
  </section>
</template>
