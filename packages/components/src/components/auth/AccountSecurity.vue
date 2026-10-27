<script setup lang="ts">
import { ArrowLeft } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import type { AccountUser } from "@deskfleet/client/central"
import { useRecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import BrandLogo from "../common/BrandLogo.vue"
import UserAvatar from "../common/UserAvatar.vue"
import AccountCredentials from "./AccountCredentials.vue"
import AccountPasskeys from "./AccountPasskeys.vue"
import AccountSessions from "./AccountSessions.vue"
import ReauthDialog from "./ReauthDialog.vue"

/** Web owns credential management; Electron opens this page in the system browser. */
defineProps<{ account: AccountAuthentication; user: AccountUser }>()
const { t, locale } = useI18n()
const recent = useRecentAuthentication()
const formatDate = (value: string | number) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
</script>

<template>
  <div class="min-h-full bg-ui-canvas text-ui-text">
    <header class="border-b border-ui-border">
      <div class="mx-auto flex h-14 max-w-2xl items-center justify-between gap-4 px-4">
        <a href="/" class="flex items-center gap-2.5 text-[15px] font-semibold"><BrandLogo :size="24" decorative />deskfleet</a>
        <a href="/" class="ui-button-ghost h-8"><ArrowLeft :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.back") }}</a>
      </div>
    </header>
    <main class="mx-auto max-w-2xl px-4 py-10">
      <header class="mb-8 flex items-center gap-4">
        <UserAvatar :name="user.name" :email="user.email" :size="48" class="text-base" />
        <div class="min-w-0">
          <h1 class="ui-page-title">{{ t("auth.security") }}</h1>
          <p class="m-0 mt-0.5 truncate text-[13px] text-ui-text-muted">{{ user.name }} · {{ user.email }}</p>
        </div>
      </header>
      <AccountCredentials :account="account" :user="user" :confirmed="recent.confirmed" />
      <AccountPasskeys :account="account" :confirmed="recent.confirmed" :format-date="formatDate" />
      <AccountSessions :account="account" :confirmed="recent.confirmed" :format-date="formatDate" />
    </main>
    <ReauthDialog v-if="recent.prompting.value" :reauthenticate="account.reauthenticate" @settle="recent.settle" />
  </div>
</template>
