<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"

defineProps<{ label: string; disabled?: boolean }>()
const { t } = useI18n()
const account = useAccountSession()
const fleet = useFleetStore()
// The account owns the roster; selection remounts the page in that machine's runtime.
const machines = computed(() => account?.machines.value ?? fleet.machines)
</script>

<template>
  <nav :aria-label="label" class="flex gap-5 overflow-x-auto border-b border-ui-border">
    <button v-for="item in machines" :key="item.id" type="button" class="relative flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-0 pb-3 text-sm disabled:cursor-not-allowed disabled:opacity-50" :class="item.id === fleet.targetId ? 'border-ui-accent text-ui-text' : 'border-transparent text-ui-text-muted hover:text-ui-text'" :aria-current="item.id === fleet.targetId ? 'page' : undefined" :disabled="disabled" @click="account?.selectMachine(item.id)">
      <span class="h-1.5 w-1.5 rounded-full" :class="item.online ? 'bg-ui-success' : 'bg-ui-text-muted'" aria-hidden="true" />
      {{ item.name }}
      <span v-if="!item.online" class="sr-only">{{ t('machine.offline') }}</span>
    </button>
  </nav>
</template>
