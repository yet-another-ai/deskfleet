<script setup lang="ts">
import { ChevronDown } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import ProviderIcon from "../common/ProviderIcon.vue"

const props = defineProps<{ providers: { id: string; name: string; icon?: string; template: string }[]; disabled?: boolean }>()
const selectedId = defineModel<string>({ required: true })
const selected = computed(() => props.providers.find(provider => provider.id === selectedId.value))
const { t } = useI18n()
</script>

<template>
  <div class="relative inline-flex min-w-0 max-w-64 items-center text-[13px] text-ui-text-muted">
    <ProviderIcon :icon="selected?.icon" :template="selected?.template" :size="15" class="pointer-events-none absolute left-1" />
    <select v-model="selectedId" :aria-label="t('providers.choose')" :disabled="disabled || !providers.length" data-composer-context class="h-7 min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent pr-6 pl-6 text-inherit hover:bg-ui-hover focus:outline-ui-text-faint disabled:cursor-default disabled:opacity-50">
      <option v-if="!providers.length" value="">{{ t('providers.choose') }}</option>
      <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
    </select>
    <ChevronDown :size="13" :stroke-width="2" class="pointer-events-none absolute right-1" aria-hidden="true" />
  </div>
</template>
