<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import type { UpdateState } from "@deskfleet/client/updates"
import { Download } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, onScopeDispose, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import UiButton from "../common/UiButton.vue"

const { t } = useI18n()
const api = client.updates
const state = shallowRef<UpdateState>({ status: "disabled" })
let receivedEvent = false
let disposed = false
if (api) {
  const unsubscribe = api.onChanged(value => {
    receivedEvent = true
    state.value = value
  })
  // A newer event must win over an initial snapshot still crossing IPC.
  void api.get().then(value => {
    if (!disposed && !receivedEvent) state.value = value
  }).catch(() => {})
  onScopeDispose(() => { disposed = true; unsubscribe() })
}

const { isLoading, executeImmediate } = useAsyncState(() => api!.install(), undefined, {
  immediate: false,
  onError(error) {
    state.value = { ...state.value, status: "error", error: error instanceof Error ? error.message : String(error) }
  },
})
const visible = computed(() => Boolean(api && state.value.version && state.value.status !== "disabled" && state.value.status !== "idle"))
const busy = computed(() => isLoading.value || ["checking", "downloading", "installing"].includes(state.value.status))
const label = computed(() => {
  if (state.value.status === "checking") return t("updates.checking")
  if (state.value.status === "downloading") return t("updates.downloading", { percent: Math.floor(state.value.percent ?? 0) })
  if (state.value.status === "installing") return t("updates.installing")
  if (state.value.status === "error") return t("updates.retry")
  return t("updates.install")
})
function install(): void {
  if (!busy.value) void executeImmediate()
}
</script>

<template>
  <div v-if="visible" data-app-update class="app-no-drag shrink-0 px-2 pb-2">
    <div class="rounded-lg border border-ui-accent/25 bg-ui-accent/8 p-2">
      <p class="m-0 mb-2 px-0.5 text-xs text-ui-text-muted">{{ t("updates.available", { version: state.version }) }}</p>
      <UiButton variant="primary" class="w-full" :loading="busy" @click="install">
        <Download v-if="!busy" :size="14" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ label }}</span>
      </UiButton>
      <p v-if="state.status === 'error'" role="alert" :title="state.error" class="m-0 mt-2 break-words px-0.5 text-xs text-ui-danger">{{ t("updates.failed") }}</p>
    </div>
  </div>
</template>
