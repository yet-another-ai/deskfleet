<script setup lang="ts">
import { Bell, Bot, Info, Palette, Plug, ShieldCheck, SlidersHorizontal } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterView, useRouter } from "vue-router"
import SettingsLayout from "../components/settings/SettingsLayout.vue"
import SidebarLink from "../components/sidebar/SidebarLink.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"

const { t } = useI18n()
const router = useRouter()
const account = useAccountSession()
const client = usePlatformClient()

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
      <SidebarLink :to="{ name: 'settings-appearance' }" :icon="Palette" :label="t('settings.appearance')" replace />
      <SidebarLink :to="{ name: 'settings-notifications' }" :icon="Bell" :label="t('settings.notifications')" replace />
      <SidebarLink v-if="client.platform !== 'web' && client.onboarding" :to="{ name: 'settings-permissions' }" :icon="ShieldCheck" :label="t('permissionsSettings.title')" replace />
      <SidebarLink v-if="!account || account.machine.value" :to="{ name: 'settings-agents' }" :icon="Bot" :label="t('settings.agents')" replace />
      <SidebarLink v-if="!account || account.machine.value" :to="{ name: 'settings-mcp-servers' }" :icon="Plug" :label="t('mcpServers.title')" replace />
      <SidebarLink :to="{ name: 'settings-about' }" :icon="Info" :label="t('aboutSettings.title')" replace />
    </template>
    <RouterView />
  </SettingsLayout>
</template>
