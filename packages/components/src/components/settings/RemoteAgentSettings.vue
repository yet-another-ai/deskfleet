<script setup lang="ts">
import { computed } from "vue"
import { useAsyncState } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { RemoteAgentSettings } from "../../../../client/src/settings.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const client = usePlatformClient()
const { t } = useI18n()
const { state, isLoading, error, executeImmediate } = useAsyncState(
  (settings?: RemoteAgentSettings) => settings ? client.settings.setRemoteAgentSettings(settings) : client.settings.getRemoteAgentSettings(),
  null,
  { resetOnExecute: false },
)
const requestError = computed(() => error.value instanceof Error ? error.value.message : error.value ? String(error.value) : null)
const permissions = ["allowRead", "allowOperate"] as const

function save(permission: keyof RemoteAgentSettings, enabled: boolean) {
  if (state.value && !isLoading.value) void executeImmediate({ ...state.value, [permission]: enabled })
}
</script>

<template>
  <SettingsRow v-for="permission in permissions" :key="permission" :label="t(`settings.remoteAgents.${permission}`)" :label-id="`remote-agents-${permission}-label`" :description-id="`remote-agents-${permission}-description`">
    <template #description>{{ t(`settings.remoteAgents.${permission}Description`) }}</template>
    <UiSwitch
      :aria-labelledby="`remote-agents-${permission}-label`"
      :aria-describedby="`remote-agents-${permission}-description`"
      :model-value="state?.[permission] ?? false"
      :disabled="isLoading || !state"
      @update:model-value="save(permission, $event)"
    />
  </SettingsRow>
  <p v-if="isLoading" role="status" class="m-0 pb-3 text-[13px] text-ui-text-muted">{{ state ? t('catalog.saving') : t('settings.loading') }}</p>
  <p v-if="requestError" role="alert" class="m-0 pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
  <UiButton v-if="!state && requestError" :disabled="isLoading" @click="executeImmediate()">{{ t('settings.retryLoad') }}</UiButton>
</template>
