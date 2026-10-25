<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LocalAgentState } from "../../../../client/src/local-agent.ts"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const state = ref<LocalAgentState | null>(null)
const loading = ref(true)
const saving = ref(false)
const requestError = ref<string | null>(null)
let revision = 0
const unsubscribe = platformClient.settings.onChanged((next) => {
  revision += 1
  state.value = next
  requestError.value = null
})
const busy = computed(() => loading.value || saving.value || state.value?.status === "starting" || state.value?.status === "stopping")
const statusLabel = computed(() => {
  switch (state.value?.status) {
    case "stopped": return t("settings.stopped")
    case "starting": return t("settings.starting")
    case "running": return state.value.enabled ? t("settings.running") : t("settings.runningSeparately")
    case "stopping": return t("settings.stopping")
    case "error": return t("settings.error")
    default: return loading.value ? t("settings.loading") : t("settings.unavailable")
  }
})
const statusColor = computed(() => {
  switch (state.value?.status) {
    case "running": return "bg-ui-success"
    case "error": return "bg-ui-danger"
    default: return "bg-ui-text-faint"
  }
})
const screenCapture = computed(() => {
  const permission = state.value?.screenCapturePermission
  return state.value?.status === "running" && permission?.status !== "not-required" && permission?.status !== "granted" ? permission : undefined
})
const screenCaptureNeedsAction = computed(() => screenCapture.value?.status === "denied" || screenCapture.value?.status === "error")
const screenCaptureLabel = computed(() => {
  switch (screenCapture.value?.status) {
    case "requesting": return t("settings.screenCaptureRequesting")
    case "denied": return t("settings.screenCaptureDenied")
    case "error": return t("settings.screenCaptureError")
    default: return ""
  }
})

async function load() {
  loading.value = true
  requestError.value = null
  const currentRevision = revision
  try {
    const next = await platformClient.settings.get()
    if (revision === currentRevision) state.value = next
  } catch (error) {
    if (revision === currentRevision) requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function setEnabled(enabled: boolean) {
  saving.value = true
  requestError.value = null
  const currentRevision = revision
  try {
    const next = await platformClient.settings.setLocalAgentEnabled(enabled)
    if (revision === currentRevision) state.value = next
  } catch (error) {
    if (revision === currentRevision) requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

onMounted(load)
onBeforeUnmount(unsubscribe)
</script>

<template>
  <SettingsRow :label="t('settings.runLocalAgent')" label-id="local-agent-label" description-id="local-agent-description">
    <template #description>{{ t("settings.stopsTerminals") }}</template>
    <span class="flex items-center gap-1.5 text-[13px] text-ui-text-muted">
      <span class="h-1.5 w-1.5 rounded-full" :class="statusColor" aria-hidden="true" />
      <span role="status">{{ statusLabel }}</span>
    </span>
    <button v-if="state?.status === 'error'" type="button" class="ui-button" :disabled="busy" @click="setEnabled(state.enabled)">{{ state.enabled ? t("settings.retryStart") : t("settings.retryStop") }}</button>
    <button v-else-if="!state && requestError" type="button" class="ui-button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</button>
    <button
      type="button"
      role="switch"
      aria-labelledby="local-agent-label"
      aria-describedby="local-agent-description"
      :aria-checked="state?.enabled ?? false"
      :disabled="busy || !state"
      class="ui-switch ml-2 disabled:cursor-wait"
      @click="setEnabled(!state?.enabled)"
    >
      <span class="ui-switch-thumb" :class="state?.enabled && 'translate-x-4'" />
    </button>
  </SettingsRow>
  <div v-if="screenCapture" :data-screen-capture-permission="screenCapture.status" class="-mt-1 pb-3 text-[13px]" :class="screenCaptureNeedsAction ? 'text-ui-warning' : 'text-ui-text-muted'" :role="screenCaptureNeedsAction ? 'alert' : 'status'">
    <p class="m-0">{{ screenCaptureLabel }}</p>
    <p v-if="screenCapture.status === 'error' && screenCapture.error" class="mb-0 mt-1 break-words">{{ screenCapture.error }}</p>
  </div>
  <p v-if="requestError || state?.error" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError || state?.error }}</p>
</template>
