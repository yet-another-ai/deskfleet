<script setup lang="ts">
import { ShieldCheck } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { client } from "@deskfleet/client/platform"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useRecentAuthentication } from "../composables/useRecentAuthentication.ts"
import { router } from "../router/index.ts"
import ReauthDialog from "../components/auth/ReauthDialog.vue"
import SettingsLayout from "../components/settings/SettingsLayout.vue"
import SiteIdentitySettings from "../components/settings/SiteIdentitySettings.vue"
import EnterpriseTeams from "../components/settings/EnterpriseTeams.vue"
import SiteSettings from "../components/settings/SiteSettings.vue"

const { t } = useI18n()
const session = useAccountSession()
const api = client.platform === "web" ? client.siteAdministration : undefined
// Account policy and Enterprise changes need a fresh password or Passkey proof.
const recent = useRecentAuthentication()
const reauthenticate = (password?: string) => api!.reauthenticate(password)
</script>

<template>
  <SettingsLayout stack-on-small-screens @back="router.replace('/')">
    <template #nav>
      <span class="ui-nav-item ui-nav-active px-2.5"><ShieldCheck :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("siteAdmin.title") }}</span>
    </template>
    <template v-if="session?.account.value.siteAdmin && api">
      <SiteSettings :api="api" />
      <SiteIdentitySettings :api="api" :confirmed="recent.confirmed" />
      <EnterpriseTeams :api="api" :confirmed="recent.confirmed" />
      <ReauthDialog v-if="recent.prompting.value" :reauthenticate="reauthenticate" @settle="recent.settle" />
    </template>
    <template v-else>
      <h1 class="ui-page-title">{{ t("siteAdmin.title") }}</h1>
      <p role="alert" class="mt-3 text-sm text-ui-text-muted">{{ t("siteAdmin.forbidden") }}</p>
    </template>
  </SettingsLayout>
</template>
