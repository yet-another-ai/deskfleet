<script setup lang="ts">
import UiButton from "./components/common/UiButton.vue"
import UiScrollArea from "./components/common/UiScrollArea.vue"
import { computed, defineAsyncComponent, onBeforeUnmount, provide, ref, watch } from "vue"
import { useEventListener, useStorage, useTitle } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { RouterView } from "vue-router"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { OnboardingState } from "@deskfleet/client/onboarding"
import { getBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import AddMachineDialog from "./components/account/AddMachineDialog.vue"
import BrowserNotificationOnboarding from "./components/account/BrowserNotificationOnboarding.vue"
import MachineOnboarding from "./components/account/MachineOnboarding.vue"
import WelcomePage from "./components/account/WelcomePage.vue"
import BrandLogo from "./components/common/BrandLogo.vue"
import TeamAccessDialog from "./components/account/TeamAccessDialog.vue"
import TeamOnboarding from "./components/account/TeamOnboarding.vue"
import AccountFooter from "./components/sidebar/AccountFooter.vue"
import AccountNotices from "./components/sidebar/AccountNotices.vue"
import AppUpdateNotice from "./components/sidebar/AppUpdateNotice.vue"
import TeamSwitcher from "./components/sidebar/TeamSwitcher.vue"
import { router } from "./router/index.ts"
import { accountSessionKey, createAccountSession } from "./composables/useAccountSession.ts"
import { useBrowserNotifications } from "./composables/useBrowserNotifications.ts"
import { useAccountAnalytics } from "./composables/useAccountAnalytics.ts"
import { useErrorReportingUser } from "./composables/useErrorReportingUser.ts"
import { trackEvent, useFeatureGate } from "./services/analytics.ts"
import { billingReturn } from "./services/billing-events.ts"
import { createMachineRuntimes, machineRuntimesKey } from "./composables/useMachineRuntimes.ts"
import { useAppearanceStore } from "./stores/appearance.ts"
import { machineBatteriesKey, useMachineBatteriesStore } from "./stores/machine-batteries.ts"
import { useOutlineAudioStore } from "./stores/outline-audio.ts"
import { platformClientKey } from "./composables/usePlatformClient.ts"

const loadMachineSurface = () => import("./components/account/MachineSurface.vue")
const MachineSurface = defineAsyncComponent(loadMachineSurface)
const WorkspaceAgentSetupView = defineAsyncComponent(() => import("./views/WorkspaceAgentSetupView.vue"))
// Overlap the workspace bundle with the account status request.
void loadMachineSurface()

const props = defineProps<{ host: DeskfleetDesktopApi }>()
const pushNotificationsEnabled = useFeatureGate("mobile_push_notifications")
const notificationsEnabled = computed(() => !props.host.mobile || pushNotificationsEnabled.value)
if (props.host.platform === "web") {
  useBrowserNotifications(props.host, target => {
    pendingNotificationTarget = target
    void navigateToNotificationSession()
  })
}
const browserNotificationOnboardingComplete = props.host.platform === "web"
  ? useStorage("deskfleet.notifications-onboarding-complete", false, undefined, { writeDefaults: false })
  : ref(true)
const browserNotificationPermission = ref(
  props.host.platform === "web" && !props.host.mobile && !props.host.settings.getNotificationPermission
    ? getBrowserNotificationPermission()
    : undefined,
)
async function refreshNotificationPermission(): Promise<void> {
  if (props.host.platform !== "web" || !notificationsEnabled.value) {
    browserNotificationPermission.value = undefined
    return
  }
  try {
    browserNotificationPermission.value = props.host.settings.getNotificationPermission
      ? await props.host.settings.getNotificationPermission()
      : getBrowserNotificationPermission()
  } catch {
    browserNotificationPermission.value = "unsupported"
  }
}
watch(notificationsEnabled, () => { void refreshNotificationPermission() }, { immediate: true })
const { t } = useI18n()
const session = createAccountSession(props.host.central!, props.host.initialError, props.host.remoteWorkspaceAgent)
useErrorReportingUser(() => session.account.value.user)
provide(platformClientKey, props.host)
provide(accountSessionKey, session)
const batteries = useMachineBatteriesStore()
batteries.attachAccount(session)
provide(machineBatteriesKey, batteries)
provide(machineRuntimesKey, createMachineRuntimes(props.host, session, useAppearanceStore(), useOutlineAudioStore(), batteries))
useAccountAnalytics(session)
const { ready, account, site, teams, team, machine, dialog } = session
let localAgentRunning: boolean | undefined
const stopLocalAgentUpdates = props.host.platform !== "web" ? props.host.settings.onChanged(state => {
  // Read enrollment after startup/shutdown settles; stopping can still accept IPC.
  if (state.status === "starting" || state.status === "stopping") return
  const running = state.status === "running"
  if (running === localAgentRunning) return
  localAgentRunning = running
  if (account.value.user) void session.refreshMachines()
}) : undefined
onBeforeUnmount(() => { stopLocalAgentUpdates?.() })
let pendingNotificationTarget: { teamId: string; machineId: string; sessionId: string } | undefined
async function navigateToNotificationSession(): Promise<void> {
  if (!pendingNotificationTarget || !notificationsEnabled.value || !ready.value || !account.value.user) return
  const target = pendingNotificationTarget
  if (!teams.value.some(value => value.id === target.teamId)) {
    pendingNotificationTarget = undefined
    return
  }
  pendingNotificationTarget = undefined
  if (session.teamId.value !== target.teamId) {
    await session.selectTeam(target.teamId)
  }
  session.openSession(target.machineId, target.sessionId)
}
if (props.host.onOpenNotificationSession) {
  const stopNotificationNavigation = props.host.onOpenNotificationSession(target => {
    pendingNotificationTarget = target
    void navigateToNotificationSession()
  })
  onBeforeUnmount(stopNotificationNavigation)
  watch([ready, account, teams, notificationsEnabled], () => { void navigateToNotificationSession() }, { immediate: true })
}
const machineScopeKey = computed(() => JSON.stringify([account.value.serverUrl, account.value.user?.id, session.teamId.value, machine.value?.id]))
const route = router.currentRoute
const returnParams = new URLSearchParams(location.search)
let billingReturnPending = props.host.platform === "web" && returnParams.get("settings") === "plans"
let billingReturnTeam: string | undefined
function finishBillingReturn(machineId?: string): void {
  if (!billingReturnTeam || team.value?.id !== billingReturnTeam || (machine.value && machine.value.id !== machineId)) return
  billingReturnTeam = undefined
  const source = billingReturn(returnParams.get("billing_return"))
  if (source && returnParams.get("team") === team.value?.id) trackEvent("billing_returned", { source })
  session.openSettings("plans")
  returnParams.delete("team"); returnParams.delete("settings")
  returnParams.delete("billing_return")
  const search = returnParams.toString()
  history.replaceState(null, "", location.pathname + (search ? `?${search}` : "") + location.hash)
}
watch([ready, account], async () => {
  if (!billingReturnPending || !ready.value || !account.value.user) return
  billingReturnPending = false
  const selected = returnParams.get("team")
  billingReturnTeam = selected && teams.value.some(value => value.id === selected) ? selected : team.value?.id
  if (billingReturnTeam) await session.selectTeam(billingReturnTeam)
  // A Machine surface initializes its own route before it signals readiness.
  if (!machine.value) finishBillingReturn()
}, { immediate: true })
useTitle(() => machine.value && ["session", "workspace-agent", "new-session"].includes(String(route.value.name)) ? undefined : (site.value?.siteName ?? "DeskFleet"))
useEventListener(window, "focus", () => {
  void refreshNotificationPermission()
  void session.reload().catch((reason: unknown) => { session.notice.value = reason instanceof Error ? reason.message : String(reason) })
})
onBeforeUnmount(session.dispose)
const onboarding = ref<OnboardingState | undefined>(props.host.onboarding ? undefined : { step: "complete", permissionSteps: [] })
const onboardingError = ref<string>()
async function loadOnboarding(): Promise<void> {
  onboardingError.value = undefined
  try { onboarding.value = await props.host.onboarding!.get() }
  catch (reason) { onboardingError.value = reason instanceof Error ? reason.message : String(reason) }
}
if (props.host.onboarding) void loadOnboarding()
</script>

<template>
  <div class="flex h-full flex-col overflow-clip bg-ui-canvas text-ui-text">
    <div v-if="site?.announcement" class="shrink-0 border-b border-ui-border bg-ui-surface">
      <UiScrollArea class="max-h-32" fade-size="sm">
        <p role="status" class="m-0 whitespace-pre-wrap break-words px-5 py-2 text-sm">{{ site.announcement }}</p>
      </UiScrollArea>
    </div>
    <template v-if="ready && onboarding">
      <BrowserNotificationOnboarding v-if="!browserNotificationOnboardingComplete && browserNotificationPermission === 'default'" :site-name="site?.siteName ?? 'DeskFleet'" @complete="browserNotificationOnboardingComplete = true" />
      <WelcomePage v-else-if="onboarding.step !== 'complete' || !account.user" :host="host" :state="onboarding" @change="onboarding = $event" />
      <!-- Only the selected route mounts here; opened machines retain their stores and peers. -->
      <MachineSurface v-else-if="machine" :key="machineScopeKey" :session="session" :machine="machine" @ready="finishBillingReturn" />
      <RouterView v-else-if="route.meta.fullWindow" />
      <div v-else class="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-clip">
        <aside class="flex w-full shrink-0 flex-col border-b border-ui-border bg-ui-sidebar pt-2 md:w-65 md:border-b-0 md:border-r md:pt-0">
          <div class="app-drag hidden h-12 shrink-0 md:block" />
          <TeamSwitcher v-if="teams.length" />
          <div class="hidden md:block md:flex-1" />
          <AccountNotices />
          <AppUpdateNotice />
          <AccountFooter />
        </aside>
        <main class="flex min-w-0 flex-1 flex-col py-6 md:py-0">
          <div class="app-drag titlebar-overlay-inset hidden h-12 shrink-0 md:block" />
          <WorkspaceAgentSetupView v-if="team && host.localChannels" :key="team.id" />
          <MachineOnboarding v-else-if="team" :remote-workspace-agent="host.remoteWorkspaceAgent" />
          <TeamOnboarding v-else-if="!teams.length" />
        </main>
      </div>
    </template>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      <BrandLogo :size="48" />
      <template v-if="onboardingError">
        <p role="alert" class="m-0 text-sm text-ui-danger">{{ onboardingError }}</p>
        <UiButton type="button" @click="loadOnboarding">{{ t("welcome.retry") }}</UiButton>
      </template>
      <p v-else role="status" class="m-0 text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    </div>
    <TeamAccessDialog v-if="dialog === 'create-team' || dialog === 'join-team'" :mode="dialog === 'create-team' ? 'create' : 'join'" @close="dialog = undefined" />
    <AddMachineDialog v-if="dialog === 'add-machine' && team" @close="dialog = undefined" />
  </div>
</template>
