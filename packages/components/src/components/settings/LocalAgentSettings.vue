<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
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
const permissions = computed(() => {
  if (state.value?.status !== "running") return []
  const values = [
    { kind: "fullDiskAccess", permission: state.value.fullDiskAccessPermission },
    { kind: "screenCapture", permission: state.value.screenCapturePermission },
    { kind: "accessibility", permission: state.value.accessibilityPermission },
  ] as const
  return values.flatMap(({ kind, permission }) => {
    if (!permission || permission.status === "not-required" || permission.status === "granted" || permission.status === "checking") return []
    const messageKind = platformClient.platform === "linux" && kind !== "fullDiskAccess"
      ? kind === "screenCapture" ? "waylandScreenCapture" : "waylandControl" : kind
    const label = permission.status === "requesting" ? t(`settings.${messageKind}Requesting`)
      : permission.status === "denied" ? t(`settings.${messageKind}Denied`) : t(`settings.${messageKind}Error`)
    return [{ kind, permission, label, needsAction: permission.status === "denied" || permission.status === "error" }]
  })
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
    <UiButton v-if="state?.status === 'error'" type="button" :disabled="busy" @click="setEnabled(state.enabled)">{{ state.enabled ? t("settings.retryStart") : t("settings.retryStop") }}</UiButton>
    <UiButton v-else-if="!state && requestError" type="button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</UiButton>
    <UiSwitch
      aria-labelledby="local-agent-label"
      aria-describedby="local-agent-description"
      :model-value="state?.enabled ?? false"
      :disabled="busy || !state"
      class="ml-2 disabled:cursor-wait"
      @update:model-value="setEnabled"
     />
  </SettingsRow>
  <div v-if="permissions.length" data-desktop-permissions role="group" :aria-label="t('settings.desktopPermissions')" class="-mt-1 flex flex-col gap-2 pb-3 text-[13px]">
    <div
      v-for="notice in permissions"
      :key="notice.kind"
      :data-full-disk-access-permission="notice.kind === 'fullDiskAccess' ? notice.permission.status : undefined"
      :data-screen-capture-permission="notice.kind === 'screenCapture' ? notice.permission.status : undefined"
      :data-accessibility-permission="notice.kind === 'accessibility' ? notice.permission.status : undefined"
      :class="notice.needsAction ? 'text-ui-warning' : 'text-ui-text-muted'"
      :role="notice.needsAction ? 'alert' : 'status'"
    >
      <p class="m-0">{{ notice.label }}</p>
      <p v-if="notice.permission.status === 'error' && notice.permission.error" class="mb-0 mt-1 break-words">{{ notice.permission.error }}</p>
    </div>
  </div>
  <p v-if="requestError || state?.error" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError || state?.error }}</p>
</template>
