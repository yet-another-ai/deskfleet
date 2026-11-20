<script setup lang="ts">
import { computed } from "vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

type ServiceAction = "get" | "enable" | "disable" | "update"

const api = usePlatformClient().windowsDesktopService
const { t } = useI18n()
const { state, isLoading, error, executeImmediate } = useAsyncState(
  async (action: ServiceAction = "get"): Promise<WindowsDesktopServiceState | null> => {
    if (!api) return null
    if (action === "get") return api.get()
    if (action === "update") return api.update ? api.update() : api.setEnabled(true)
    return api.setEnabled(action === "enable")
  },
  null,
  // Setup failures (including cancelled UAC) are handled by the inline alert.
  { resetOnExecute: false, onError: () => {} },
)
const requestError = computed(() => error.value instanceof Error ? error.value.message : error.value ? String(error.value) : null)
useEventListener("focus", () => { if (!isLoading.value) void executeImmediate("get") })
defineExpose({ refresh: () => { if (!isLoading.value) void executeImmediate("get") } })
</script>

<template>
  <template v-if="api">
    <SettingsRow :label="t('settings.windowsLockControl')" label-id="windows-lock-control-label" description-id="windows-lock-control-description">
      <template #description>{{ t(state?.available === false ? "settings.windowsLockControlUnavailable" : "settings.windowsLockControlDescription") }}</template>
      <span v-if="isLoading" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.windowsLockControlWorking") }}</span>
      <span v-else-if="state?.installed && !state.running" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.windowsLockControlStopped") }}</span>
      <span v-else-if="state?.installed && state.updateAvailable" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.windowsLockControlUpdateAvailable") }}</span>
      <UiButton v-if="!state && requestError" type="button" :disabled="isLoading" @click="executeImmediate('get')">{{ t("settings.retryLoad") }}</UiButton>
      <UiButton v-if="state?.installed && !state.running" type="button" :disabled="isLoading" @click="executeImmediate('enable')">{{ t("settings.windowsLockControlStart") }}</UiButton>
      <UiButton v-else-if="state?.installed && state.updateAvailable" type="button" :disabled="isLoading" @click="executeImmediate('update')">{{ t("settings.windowsLockControlUpdate") }}</UiButton>
      <UiSwitch
        aria-labelledby="windows-lock-control-label"
        aria-describedby="windows-lock-control-description"
        :model-value="state?.installed ?? false"
        :disabled="isLoading || !state?.available"
        class="ml-2 disabled:cursor-default"
        @update:model-value="enabled => executeImmediate(enabled ? 'enable' : 'disable')"
      />
    </SettingsRow>
    <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words px-4 pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
  </template>
</template>
