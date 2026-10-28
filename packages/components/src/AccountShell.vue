<script setup lang="ts">
import UiButton from "./components/common/UiButton.vue"
import { defineAsyncComponent, onBeforeUnmount, provide, ref, watch } from "vue"
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
import { trackEvent } from "./services/analytics.ts"
import { billingReturn } from "./services/billing-events.ts"

const loadMachineSurface = () => import("./components/account/MachineSurface.vue")
const MachineSurface = defineAsyncComponent(loadMachineSurface)
// Overlap the workspace bundle with the account status request.
void loadMachineSurface()

const props = defineProps<{ host: DeskfleetDesktopApi }>()
if (props.host.platform === "web") useBrowserNotifications(props.host)
const browserNotificationOnboardingComplete = props.host.platform === "web"
  ? useStorage("deskfleet.notifications-onboarding-complete", false, undefined, { writeDefaults: false })
  : ref(true)
const browserNotificationPermission = ref(props.host.platform === "web" ? getBrowserNotificationPermission() : undefined)
const { t } = useI18n()
const session = createAccountSession(props.host.central!, props.host.initialError)
useAccountAnalytics(session)
const { ready, account, site, teams, team, machine, dialog } = session
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
useTitle(() => site.value?.siteName ?? "DeskFleet")
useEventListener(window, "focus", () => {
  if (props.host.platform === "web") browserNotificationPermission.value = getBrowserNotificationPermission()
  void session.reload().catch((reason: unknown) => { session.notice.value = reason instanceof Error ? reason.message : String(reason) })
})
provide(accountSessionKey, session)
onBeforeUnmount(session.dispose)
const onboarding = ref<OnboardingState | undefined>(props.host.onboarding ? undefined : { step: "complete" })
const onboardingError = ref<string>()
async function loadOnboarding(): Promise<void> {
  onboardingError.value = undefined
  try { onboarding.value = await props.host.onboarding!.get() }
  catch (reason) { onboardingError.value = reason instanceof Error ? reason.message : String(reason) }
}
if (props.host.onboarding) void loadOnboarding()
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ui-canvas text-ui-text">
    <p v-if="site?.announcement" role="status" class="m-0 max-h-32 shrink-0 overflow-y-auto whitespace-pre-wrap break-words border-b border-ui-border bg-ui-surface px-5 py-2 text-sm">{{ site.announcement }}</p>
    <template v-if="ready && onboarding">
      <BrowserNotificationOnboarding v-if="!browserNotificationOnboardingComplete && browserNotificationPermission === 'default'" :site-name="site?.siteName ?? 'DeskFleet'" @complete="browserNotificationOnboardingComplete = true" />
      <WelcomePage v-else-if="onboarding.step !== 'complete' || !account.user" :host="host" :state="onboarding" @change="onboarding = $event" />
      <!-- Each selected machine runs in its own application scope; see MachineSurface. -->
      <MachineSurface v-else-if="machine" :key="machine.id" :host="host" :session="session" :machine="machine" @ready="finishBillingReturn" />
      <RouterView v-else-if="route.meta.fullWindow" />
      <div v-else class="flex min-h-0 flex-1">
        <aside class="flex w-65 shrink-0 flex-col border-r border-ui-border bg-ui-sidebar">
          <div class="app-drag h-12 shrink-0" />
          <TeamSwitcher v-if="teams.length" />
          <div class="flex-1" />
          <AccountNotices />
          <AppUpdateNotice />
          <AccountFooter />
        </aside>
        <main class="flex min-w-0 flex-1 flex-col">
          <div class="app-drag titlebar-overlay-inset h-12 shrink-0" />
          <MachineOnboarding v-if="team" />
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
