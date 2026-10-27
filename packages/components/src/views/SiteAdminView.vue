<script setup lang="ts">
import { ShieldCheck } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { client } from "@deskfleet/client/platform"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { router } from "../router/index.ts"
import SettingsLayout from "../components/settings/SettingsLayout.vue"
import SiteSettings from "../components/settings/SiteSettings.vue"

const { t } = useI18n()
const session = useAccountSession()
const api = client.platform === "web" ? client.siteAdministration : undefined
</script>

<template>
  <SettingsLayout stack-on-small-screens @back="router.replace('/')">
    <template #nav>
      <span class="ui-nav-item ui-nav-active px-2.5"><ShieldCheck :size="16" :stroke-width="1.75" aria-hidden="true" />{{ t("siteAdmin.title") }}</span>
    </template>
    <SiteSettings v-if="session?.account.value.siteAdmin && api" :api="api" />
    <template v-else>
      <h1 class="ui-page-title">{{ t("siteAdmin.title") }}</h1>
      <p role="alert" class="mt-3 text-sm text-ui-text-muted">{{ t("siteAdmin.forbidden") }}</p>
    </template>
  </SettingsLayout>
</template>
