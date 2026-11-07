<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiTabTitle from "../common/UiTabTitle.vue"

defineProps<{ label: string; disabled?: boolean }>()
const { t } = useI18n()
const account = useAccountSession()
const fleet = useFleetStore()
// The account owns the roster; selection remounts the page in that machine's runtime.
const machines = computed(() => account?.machines.value ?? fleet.machines)
</script>

<template>
  <nav :aria-label="label" class="flex gap-5 overflow-x-auto border-b border-ui-border">
    <button v-for="item in machines" :key="item.id" type="button" class="ui-tab gap-2 pb-3 text-sm disabled:cursor-not-allowed disabled:opacity-50" :class="item.id === fleet.targetId && 'ui-tab-active'" :aria-current="item.id === fleet.targetId ? 'page' : undefined" :disabled="disabled" @click="account?.selectMachine(item.id)">
      <span class="ui-status-dot" :class="item.online ? 'text-ui-success' : 'text-ui-text-faint'" aria-hidden="true" />
      <UiTabTitle :title="item.name">{{ item.name }}</UiTabTitle>
      <span v-if="!item.online" class="sr-only">{{ ` ${t('machine.offline')}` }}</span>
    </button>
  </nav>
</template>
