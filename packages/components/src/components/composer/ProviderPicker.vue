<script setup lang="ts">
import UiSelect from "../common/UiSelect.vue"
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
    <UiSelect v-model="selectedId" :options="providers.map(provider => ({ value: provider.id, label: provider.name }))" :placeholder="t('providers.choose')" :aria-label="t('providers.choose')" :disabled="disabled || !providers.length" data-composer-context class="h-7 border-transparent bg-transparent py-0 pl-6 text-inherit" />
  </div>
</template>
