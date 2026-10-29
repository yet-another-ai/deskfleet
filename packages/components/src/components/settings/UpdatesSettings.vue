<script setup lang="ts">
import type { UpdateState } from "@deskfleet/client/updates"
import { Download, RefreshCw } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const api = usePlatformClient().updates
const state = shallowRef<UpdateState | null>(api ? null : { status: "disabled" })
const checked = ref(false)
let revision = 0
let disposed = false
const unsubscribe = api?.onChanged(value => {
  revision++
  state.value = value
})
onScopeDispose(() => { disposed = true; unsubscribe?.() })

const { isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(async () => {
  const requestedAt = revision
  const value = await api!.get()
  if (!disposed && revision === requestedAt) state.value = value
}, undefined, { immediate: Boolean(api) })

const { isLoading: checking, error: checkError, executeImmediate: check } = useAsyncState(async () => {
  checked.value = false
  const requestedAt = revision
  const value = await api!.check()
  if (disposed) return
  if (revision === requestedAt) state.value = value
  checked.value = true
}, undefined, { immediate: false })

const { isLoading: installing, executeImmediate: install } = useAsyncState(() => api!.install(), undefined, {
  immediate: false,
  onError(error) {
    if (state.value) state.value = { ...state.value, status: "error", error: errorMessage(error) }
  },
})

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
const busy = computed(() => loading.value || checking.value || installing.value || ["checking", "downloading", "installing"].includes(state.value?.status ?? ""))
const canInstall = computed(() => Boolean(state.value?.version && state.value.status !== "disabled" && state.value.status !== "idle"))
const status = computed(() => {
  if (checking.value || state.value?.status === "checking") return t("updates.checking")
  if (state.value?.status === "downloading") return t("updates.downloading", { percent: Math.floor(state.value.percent ?? 0) })
  if (state.value?.status === "installing") return t("updates.installing")
  if (state.value?.status === "disabled") return t("updatesSettings.unavailable")
  if (state.value?.version) return t("updates.available", { version: state.value.version })
  return checked.value ? t("updatesSettings.upToDate") : t("updatesSettings.ready")
})

function checkForUpdates(): void {
  if (!busy.value && state.value?.status !== "disabled") void check()
}
function installUpdate(): void {
  if (!busy.value && canInstall.value) void install()
}
</script>

<template>
  <h1 class="ui-page-title mb-2">{{ t("updatesSettings.title") }}</h1>
  <p class="m-0 mb-6 text-sm leading-relaxed text-ui-text-muted">{{ t("updatesSettings.description") }}</p>
  <section :aria-label="t('updatesSettings.title')" class="ui-card px-4">
    <SettingsRow v-if="state?.currentVersion" :label="t('updatesSettings.currentVersion')">
      <span class="text-sm text-ui-text-muted">{{ state.currentVersion }}</span>
    </SettingsRow>
    <div v-if="state" class="py-4">
      <p role="status" aria-live="polite" class="m-0 text-sm">{{ status }}</p>
      <div class="mt-4 flex flex-wrap gap-2">
        <UiButton :loading="checking || state.status === 'checking'" :disabled="busy || state.status === 'disabled'" @click="checkForUpdates">
          <RefreshCw v-if="!checking && state.status !== 'checking'" :size="14" aria-hidden="true" />
          {{ t("updatesSettings.check") }}
        </UiButton>
        <UiButton v-if="canInstall" variant="primary" :loading="installing || state.status === 'downloading' || state.status === 'installing'" :disabled="busy" @click="installUpdate">
          <Download v-if="!busy" :size="14" aria-hidden="true" />
          {{ t(state.status === "error" ? "updates.retry" : "updates.install") }}
        </UiButton>
      </div>
      <p v-if="checkError" role="alert" :title="errorMessage(checkError)" class="m-0 mt-3 text-[13px] text-ui-danger">{{ t("updatesSettings.checkFailed") }}</p>
      <p v-if="state.status === 'error'" role="alert" :title="state.error" class="m-0 mt-3 text-[13px] text-ui-danger">{{ t("updates.failed") }}</p>
    </div>
    <p v-else-if="loading" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("settings.loading") }}</p>
    <div v-if="loadError && !state" class="py-4">
      <p role="alert" class="m-0 mb-3 break-words text-[13px] text-ui-danger">{{ errorMessage(loadError) }}</p>
      <UiButton :loading="loading" @click="() => load()">{{ t("settings.retryLoad") }}</UiButton>
    </div>
  </section>
</template>
