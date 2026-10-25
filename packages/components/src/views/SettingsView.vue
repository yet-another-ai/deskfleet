<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { Bell, Bot, SlidersHorizontal, Users } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterView, useRouter } from "vue-router"
import SettingsLayout from "../components/settings/SettingsLayout.vue"
import SidebarLink from "../components/sidebar/SidebarLink.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"

const { t } = useI18n()
const router = useRouter()
const account = useAccountSession()

// Section links replace their history entry, so the previous entry is the page Settings opened from.
function leave(): void {
  const state = window.history.state as { back?: string | null } | null
  if (state?.back != null) router.back()
  else void router.push({ name: "new-session" })
}
</script>

<template>
  <SettingsLayout @back="leave">
    <template #nav>
      <SidebarLink :to="{ name: 'settings-preferences' }" :icon="SlidersHorizontal" :label="t('settings.preferences')" replace />
      <SidebarLink v-if="client.platform !== 'web'" :to="{ name: 'settings-notifications' }" :icon="Bell" :label="t('settings.notifications')" replace />
      <SidebarLink :to="{ name: 'settings-agents' }" :icon="Bot" :label="t('settings.agents')" replace />
      <SidebarLink v-if="account?.team.value" :to="{ name: 'settings-team' }" :icon="Users" :label="t('team.settings')" replace />
    </template>
    <RouterView />
  </SettingsLayout>
</template>
