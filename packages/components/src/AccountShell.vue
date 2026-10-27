<script setup lang="ts">
import UiButton from "./components/common/UiButton.vue"
import { Bell, Palette, SlidersHorizontal, Users } from "@lucide/vue"
import { defineAsyncComponent, onBeforeUnmount, provide, ref } from "vue"
import { useEventListener, useStorage, useTitle } from "@vueuse/core"
import { useI18n } from "vue-i18n"
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
import PreferencesSettings from "./components/settings/PreferencesSettings.vue"
import AppearanceSettings from "./components/settings/AppearanceSettings.vue"
import NotificationsSettings from "./components/settings/NotificationsSettings.vue"
import SettingsLayout from "./components/settings/SettingsLayout.vue"
import AccountFooter from "./components/sidebar/AccountFooter.vue"
import AccountNotices from "./components/sidebar/AccountNotices.vue"
import TeamSwitcher from "./components/sidebar/TeamSwitcher.vue"
import TeamSettings from "./components/team/TeamSettings.vue"
import SiteAdminView from "./views/SiteAdminView.vue"
import { router } from "./router/index.ts"
import { accountSessionKey, createAccountSession, type AccountSettingsSection } from "./composables/useAccountSession.ts"
import { useBrowserNotifications } from "./composables/useBrowserNotifications.ts"

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
const { ready, account, site, teams, team, machine, dialog, shellSettings } = session
const route = router.currentRoute
useTitle(() => site.value?.siteName ?? "deskfleet")
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
const section = (value: AccountSettingsSection) => [
  "ui-nav-item w-full cursor-pointer px-2.5 text-left",
  shellSettings.value === value && "ui-nav-active",
]
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ui-canvas text-ui-text">
    <p v-if="site?.announcement" role="status" class="m-0 max-h-32 shrink-0 overflow-y-auto whitespace-pre-wrap break-words border-b border-ui-border bg-ui-surface px-5 py-2 text-sm">{{ site.announcement }}</p>
    <template v-if="ready && onboarding">
      <BrowserNotificationOnboarding v-if="!browserNotificationOnboardingComplete && browserNotificationPermission === 'default'" :site-name="site?.siteName ?? 'deskfleet'" @complete="browserNotificationOnboardingComplete = true" />
      <WelcomePage v-else-if="onboarding.step !== 'complete' || !account.user" :host="host" :state="onboarding" @change="onboarding = $event" />
      <!-- Each selected machine runs in its own application scope; see MachineSurface. -->
      <MachineSurface v-else-if="machine" :key="machine.id" :host="host" :session="session" :machine="machine" />
      <SiteAdminView v-else-if="host.platform === 'web' && route.name === 'site-admin'" />
      <SettingsLayout v-else-if="shellSettings" @back="shellSettings = undefined">
        <template #nav>
          <button type="button" :class="section('preferences')" @click="shellSettings = 'preferences'"><SlidersHorizontal :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("settings.preferences") }}</button>
          <button type="button" :class="section('appearance')" @click="shellSettings = 'appearance'"><Palette :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("settings.appearance") }}</button>
          <button type="button" :class="section('notifications')" @click="shellSettings = 'notifications'"><Bell :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("settings.notifications") }}</button>
          <button v-if="team" type="button" :class="section('team')" @click="shellSettings = 'team'"><Users :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("team.settings") }}</button>
        </template>
        <TeamSettings v-if="shellSettings === 'team'" />
        <NotificationsSettings v-else-if="shellSettings === 'notifications'" />
        <AppearanceSettings v-else-if="shellSettings === 'appearance'" />
        <PreferencesSettings v-else />
      </SettingsLayout>
      <div v-else class="flex min-h-0 flex-1">
        <aside class="flex w-65 shrink-0 flex-col border-r border-ui-border bg-ui-sidebar">
          <div class="app-drag h-12 shrink-0" />
          <TeamSwitcher v-if="teams.length" />
          <div class="flex-1" />
          <AccountNotices />
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
