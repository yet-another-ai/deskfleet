<script setup lang="ts">
import { DESKTOP_ONBOARDING_PERMISSIONS, onboardingPermissions, type OnboardingPermission, type OnboardingPermissionsState } from "@deskfleet/client/onboarding"
import type { DesktopPermissionsState } from "@deskfleet/client/local-agent"
import { FolderOpen, Monitor, MousePointer2, Network, RefreshCw } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"

const client = usePlatformClient()
const onboarding = client.onboarding
const { t } = useI18n()
const permissionSteps = ref<readonly OnboardingPermission[]>([])
const permissions = ref<OnboardingPermissionsState>({})
const backend = ref<DesktopPermissionsState["linuxDesktopBackend"]>()
const refreshing = ref(false)
const pending = ref(false)
const error = ref<string>()
let revision = 0
const busy = computed(() => refreshing.value || pending.value)
const wayland = computed(() => client.platform === "linux" && backend.value === "wayland")
const sharedRequest = computed(() => wayland.value && DESKTOP_ONBOARDING_PERMISSIONS.some(kind => permissions.value[`${kind}Permission`]?.status === "requesting"))
const icons = { localNetwork: Network, fullDiskAccess: FolderOpen, screenCapture: Monitor, accessibility: MousePointer2 }
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const details = (kind: OnboardingPermission) => `welcome.${wayland.value ? "wayland" : "permissions"}.${kind}`
const label = (kind: OnboardingPermission) => t(wayland.value ? `${details(kind)}.title` : `welcome.steps.${kind}`)
const desktopPermission = (kind: OnboardingPermission) => kind === "localNetwork" ? undefined : permissions.value[`${kind}Permission`]
const granted = (kind: OnboardingPermission) => ["granted", "not-required"].includes(desktopPermission(kind)?.status ?? "")
const requesting = (kind: OnboardingPermission) => sharedRequest.value || desktopPermission(kind)?.status === "requesting"
const canRequest = (kind: OnboardingPermission) => !busy.value && !granted(kind) && !requesting(kind)
  && (!wayland.value || desktopPermission(kind)?.status !== "checking")

function accept(value: OnboardingPermissionsState, requestedRevision: number): void {
  // Local network attempts belong to the host and never arrive in daemon events.
  if (value.localNetwork !== undefined) permissions.value.localNetwork = value.localNetwork
  if (revision !== requestedRevision) return
  permissions.value = { ...permissions.value, ...value }
  if (value.linuxDesktopBackend !== undefined) {
    backend.value = value.linuxDesktopBackend
    permissionSteps.value = onboardingPermissions(client.platform, backend.value, permissionSteps.value.some(kind => kind !== "localNetwork"))
  }
}

async function refresh(): Promise<void> {
  if (!onboarding || busy.value) return
  refreshing.value = true
  error.value = undefined
  const requestedRevision = revision
  try {
    const state = await onboarding.get()
    if (revision === requestedRevision) {
      permissionSteps.value = state.permissionSteps
      backend.value = state.linuxDesktopBackend
    }
    if (permissionSteps.value.length) accept(await onboarding.permissions(), requestedRevision)
  } catch (reason) { error.value = message(reason) }
  finally { refreshing.value = false }
}

async function requestPermission(kind: OnboardingPermission): Promise<void> {
  if (!onboarding || !canRequest(kind)) return
  pending.value = true
  error.value = undefined
  const requestedRevision = ++revision
  try { accept(await onboarding.requestPermission(kind), requestedRevision) }
  catch (reason) { error.value = message(reason) }
  finally { pending.value = false }
}

async function openLocalNetworkSettings(): Promise<void> {
  if (!onboarding || busy.value) return
  pending.value = true
  error.value = undefined
  try { await onboarding.openLocalNetworkSettings() }
  catch (reason) { error.value = message(reason) }
  finally { pending.value = false }
}

const unsubscribe = onboarding ? client.settings.onChanged(state => {
  if (state.linuxDesktopBackend !== undefined) backend.value = state.linuxDesktopBackend
  const nextSteps = onboardingPermissions(client.platform, backend.value, state.enabled || state.status === "running")
  const stepsChanged = nextSteps.length !== permissionSteps.value.length || nextSteps.some((kind, index) => kind !== permissionSteps.value[index])
  // Missing permission data in a lifecycle event is not a new access decision.
  if (stepsChanged || state.linuxDesktopBackend !== undefined || DESKTOP_ONBOARDING_PERMISSIONS.some(kind => state[`${kind}Permission`])) ++revision
  for (const kind of DESKTOP_ONBOARDING_PERMISSIONS) {
    const value = state[`${kind}Permission`]
    if (value !== undefined) permissions.value[`${kind}Permission`] = value
  }
  permissionSteps.value = nextSteps
}) : undefined
useEventListener(window, "focus", () => { void refresh() })
onMounted(() => { void refresh() })
onBeforeUnmount(() => { unsubscribe?.() })
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <h1 class="ui-page-title m-0">{{ t("permissionsSettings.title") }}</h1>
    <UiButton v-if="onboarding" type="button" :disabled="busy" @click="refresh">
      <RefreshCw :size="14" :class="refreshing && 'animate-spin'" aria-hidden="true" />
      {{ t(refreshing ? "permissionsSettings.refreshing" : "permissionsSettings.refresh") }}
    </UiButton>
  </div>
  <p class="m-0 mb-6 text-sm leading-relaxed text-ui-text-muted">{{ t("permissionsSettings.description") }}</p>
  <p v-if="!onboarding" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("permissionsSettings.unavailable") }}</p>
  <template v-else>
    <p v-if="refreshing && !permissionSteps.length" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("permissionsSettings.refreshing") }}</p>
    <p v-else-if="!permissionSteps.length && !error" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("permissionsSettings.noPermissions") }}</p>
    <p v-if="error" role="alert" class="m-0 mb-4 break-words text-sm text-ui-danger">{{ error }}</p>
    <div class="flex flex-col gap-4">
      <section v-for="kind in permissionSteps" :key="kind" :data-permission="kind" :aria-labelledby="`permission-${kind}`" class="ui-card p-4">
        <div class="flex items-center gap-2">
          <component :is="icons[kind]" :size="17" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <h2 :id="`permission-${kind}`" class="m-0 text-sm font-medium">{{ label(kind) }}</h2>
        </div>
        <p class="m-0 mt-2 text-[13px] leading-relaxed text-ui-text-muted">{{ t(`${details(kind)}.description`) }}</p>
        <p class="m-0 mt-3 text-xs leading-relaxed text-ui-text-muted">{{ t(`${details(kind)}.${wayland ? 'instructions' : 'path'}`) }}</p>
        <p v-if="kind === 'localNetwork'" class="m-0 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t("welcome.permissions.localNetwork.instructions") }}</p>
        <p v-else class="m-0 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t(wayland ? "permissionsSettings.waylandShared" : "permissionsSettings.restart") }}</p>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p role="status" class="m-0 text-[13px]" :class="granted(kind) ? 'text-ui-success' : 'text-ui-text-muted'">
            {{ t(kind === 'localNetwork' ? `welcome.permissions.localNetwork.status.${permissions.localNetwork ?? 'not-requested'}` : wayland && requesting(kind) ? 'welcome.wayland.requesting' : `welcome.permissionStatus.${desktopPermission(kind)?.status ?? 'checking'}`) }}
          </p>
          <div class="flex flex-wrap gap-2">
            <template v-if="kind === 'localNetwork'">
              <UiButton v-if="permissions.localNetwork !== 'not-required'" type="button" :disabled="busy" @click="requestPermission(kind)">{{ t("welcome.permissions.localNetwork.request") }}</UiButton>
              <UiButton type="button" :disabled="busy" @click="openLocalNetworkSettings">{{ t("welcome.permissions.localNetwork.openSettings") }}</UiButton>
            </template>
            <UiButton v-else-if="!granted(kind)" type="button" :disabled="!canRequest(kind)" @click="requestPermission(kind)">{{ t(wayland ? "welcome.wayland.retry" : "welcome.openSettings") }}</UiButton>
          </div>
        </div>
        <p v-if="desktopPermission(kind)?.error" role="alert" class="m-0 mt-3 break-words text-[13px] text-ui-danger">{{ desktopPermission(kind)?.error }}</p>
      </section>
    </div>
  </template>
</template>
