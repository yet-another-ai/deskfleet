<script setup lang="ts">
import { computed } from "vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const api = usePlatformClient().windowsDesktopService
const { t } = useI18n()
const { state, isLoading, error, executeImmediate } = useAsyncState(
  async (enabled?: boolean): Promise<WindowsDesktopServiceState | null> => {
    if (!api) return null
    return enabled === undefined ? api.get() : api.setEnabled(enabled)
  },
  null,
  // Setup failures (including cancelled UAC) are handled by the inline alert.
  { resetOnExecute: false, onError: () => {} },
)
const requestError = computed(() => error.value instanceof Error ? error.value.message : error.value ? String(error.value) : null)
useEventListener("focus", () => { if (!isLoading.value) void executeImmediate() })
</script>

<template>
  <template v-if="api">
    <SettingsRow :label="t('settings.windowsLockControl')" label-id="windows-lock-control-label" description-id="windows-lock-control-description">
      <template #description>{{ t(state?.available === false ? "settings.windowsLockControlUnavailable" : "settings.windowsLockControlDescription") }}</template>
      <span v-if="isLoading" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.windowsLockControlWorking") }}</span>
      <span v-else-if="state?.installed && !state.running" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.windowsLockControlStopped") }}</span>
      <UiButton v-if="!state && requestError" type="button" :disabled="isLoading" @click="executeImmediate()">{{ t("settings.retryLoad") }}</UiButton>
      <UiButton v-if="state?.installed && !state.running" type="button" :disabled="isLoading" @click="executeImmediate(true)">{{ t("settings.windowsLockControlStart") }}</UiButton>
      <UiSwitch
        aria-labelledby="windows-lock-control-label"
        aria-describedby="windows-lock-control-description"
        :model-value="state?.installed ?? false"
        :disabled="isLoading || !state?.available"
        class="ml-2 disabled:cursor-default"
        @update:model-value="executeImmediate"
      />
    </SettingsRow>
    <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
  </template>
</template>
