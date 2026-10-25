<script setup lang="ts">
import { SlidersHorizontal, Users } from "@lucide/vue"
import { onBeforeUnmount, provide } from "vue"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import AddMachineDialog from "./components/account/AddMachineDialog.vue"
import MachineOnboarding from "./components/account/MachineOnboarding.vue"
import MachineSurface from "./components/account/MachineSurface.vue"
import SignIn from "./components/account/SignIn.vue"
import TeamAccessDialog from "./components/account/TeamAccessDialog.vue"
import TeamOnboarding from "./components/account/TeamOnboarding.vue"
import PreferencesSettings from "./components/settings/PreferencesSettings.vue"
import SettingsLayout from "./components/settings/SettingsLayout.vue"
import AccountFooter from "./components/sidebar/AccountFooter.vue"
import AccountNotices from "./components/sidebar/AccountNotices.vue"
import TeamSwitcher from "./components/sidebar/TeamSwitcher.vue"
import TeamSettings from "./components/team/TeamSettings.vue"
import { accountSessionKey, createAccountSession } from "./composables/useAccountSession.ts"

const props = defineProps<{ host: DeskfleetDesktopApi }>()
const { t } = useI18n()
const session = createAccountSession(props.host.central!, props.host.initialError)
const { ready, account, teams, team, machine, dialog, shellSettings } = session
provide(accountSessionKey, session)
onBeforeUnmount(session.dispose)
const section = (value: "preferences" | "team") => [
  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-ui-hover",
  shellSettings.value === value && "bg-ui-active",
]
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ui-canvas text-ui-text">
    <template v-if="ready">
      <SignIn v-if="!account.user" :platform="host.platform" />
      <!-- Each selected machine runs in its own application scope; see MachineSurface. -->
      <MachineSurface v-else-if="machine" :key="machine.id" :host="host" :session="session" :machine="machine" />
      <SettingsLayout v-else-if="shellSettings" @back="shellSettings = undefined">
        <template #nav>
          <button type="button" :class="section('preferences')" @click="shellSettings = 'preferences'"><SlidersHorizontal :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("settings.preferences") }}</button>
          <button v-if="team" type="button" :class="section('team')" @click="shellSettings = 'team'"><Users :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("team.settings") }}</button>
        </template>
        <TeamSettings v-if="shellSettings === 'team'" />
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
    <TeamAccessDialog v-if="dialog === 'create-team' || dialog === 'join-team'" :mode="dialog === 'create-team' ? 'create' : 'join'" @close="dialog = undefined" />
    <AddMachineDialog v-if="dialog === 'add-machine' && team" @close="dialog = undefined" />
  </div>
</template>
