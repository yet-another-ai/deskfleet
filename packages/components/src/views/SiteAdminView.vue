<script setup lang="ts">
import { BadgeCheck, Cloud, RadioTower, Settings2, UserX, Users } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterView, useRoute } from "vue-router"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useRecentAuthentication } from "../composables/useRecentAuthentication.ts"
import { useNavigationMotion } from "../composables/useNavigationMotion.ts"
import { router } from "../router/index.ts"
import ReauthDialog from "../components/auth/ReauthDialog.vue"
import SidebarLink from "../components/sidebar/SidebarLink.vue"
import SettingsLayout from "../components/settings/SettingsLayout.vue"

const client = usePlatformClient()
const { t } = useI18n()
const route = useRoute()
const motion = useNavigationMotion()
const session = useAccountSession()
const api = client.platform === "web" ? client.siteAdministration : undefined
// Account policy and Enterprise changes need a fresh identity proof.
const recent = useRecentAuthentication()
const reauthenticate = (password?: string) => api!.reauthenticate(password)
</script>

<template>
  <SettingsLayout :motion="motion" @back="router.replace('/')">
    <template #nav>
      <template v-if="session?.account.value.siteAdmin && api">
        <SidebarLink :to="{ name: 'site-admin-settings' }" :icon="Settings2" :label="t('siteAdmin.generalTitle')" replace />
        <SidebarLink :to="{ name: 'site-admin-accounts' }" :icon="Users" :label="t('siteAdmin.accounts')" replace />
        <SidebarLink :to="{ name: 'site-admin-turn' }" :icon="RadioTower" :label="t('siteAdmin.turnTitle')" replace />
        <SidebarLink :to="{ name: 'site-admin-cloudflare-turn' }" :icon="Cloud" :label="t('siteAdmin.cloudflareTurnTitle')" replace />
        <SidebarLink :to="{ name: 'site-admin-manual-grants' }" :icon="BadgeCheck" :label="t('billing.enterpriseTeams')" replace />
        <SidebarLink :to="{ name: 'site-admin-deletion-requests' }" :icon="UserX" :label="t('siteAdmin.deletionRequests')" replace />
      </template>
    </template>
    <template v-if="session?.account.value.siteAdmin && api">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :api="api" v-bind="route.meta.recentAuthentication ? { confirmed: recent.confirmed } : {}" />
      </RouterView>
      <ReauthDialog v-if="recent.prompting.value" :reauthenticate="reauthenticate" :send-email-code="() => api!.sendEmailCode()" :verify-email-code="(challenge, code) => api!.verifyEmailCode(challenge, code)" :authentication-methods="() => api!.authenticationMethods()" @settle="recent.settle" />
    </template>
    <template v-else>
      <h1 class="ui-page-title">{{ t("siteAdmin.title") }}</h1>
      <p role="alert" class="mt-3 text-sm text-ui-text-muted">{{ t("siteAdmin.forbidden") }}</p>
    </template>
  </SettingsLayout>
</template>
