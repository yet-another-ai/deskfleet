<script setup lang="ts">
import { CreditCard, Users } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterView, useRouter } from "vue-router"
import SettingsLayout from "../components/settings/SettingsLayout.vue"
import SidebarLink from "../components/sidebar/SidebarLink.vue"

const { t } = useI18n()
const router = useRouter()

// Section links replace their history entry, preserving the page the team settings opened from.
function leave(): void {
  const state = window.history.state as { back?: string | null } | null
  if (state?.back != null) router.back()
  else void router.push({ name: "new-session" })
}
</script>

<template>
  <SettingsLayout @back="leave">
    <template #nav>
      <SidebarLink :to="{ name: 'team-settings' }" :icon="Users" :label="t('team.settings')" replace />
      <SidebarLink :to="{ name: 'team-settings-plans' }" :icon="CreditCard" :label="t('team.plansUsage')" replace />
    </template>
    <RouterView />
  </SettingsLayout>
</template>
