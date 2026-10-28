<script setup lang="ts">
import { useAsyncState, useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { accountAuthentication } from "@deskfleet/client/account-security"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import AccountSecurity from "./AccountSecurity.vue"
import AuthLayout from "./AuthLayout.vue"
import DesktopApproval from "./DesktopApproval.vue"
import EmailChangeConfirm from "./EmailChangeConfirm.vue"
import EmailLinkForm from "./EmailLinkForm.vue"
import SetPasswordForm from "./SetPasswordForm.vue"
import SignInForm from "./SignInForm.vue"

/** Routes the Web `/auth/*` pages. Each page that needs an account signs in first and then resumes. */
const props = defineProps<{ api: HttpCentralClient }>()
const { t } = useI18n()
const account = accountAuthentication(props.api)
const route = location.pathname.replace(/\/$/, "")
const attempt = new URLSearchParams(location.search).get("attempt") ?? undefined
// Mailed tokens travel in the fragment so they never reach server logs; drop them from history.
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? undefined
if (token) history.replaceState(null, "", location.pathname + location.search)
const { state, isLoading, error, executeImmediate: reload } = useAsyncState(async () => {
  const [config, status] = await Promise.all([account.config(), props.api.status()])
  return { config, user: status.user }
}, undefined)
// Registration and recovery open in another tab during desktop approval; returning here picks up that sign-in.
useEventListener(window, "focus", () => { if (route === "/auth/desktop" && !state.value?.user) void reload() })

const signedInPages: Record<string, { title: string; description?: string; newTab?: boolean }> = {
  "/auth/desktop": { title: "auth.desktopSignInTitle", description: "auth.desktopSignInDescription", newTab: true },
  "/auth/account": { title: "auth.signInTitle", description: "auth.accountSignInDescription" },
  "/auth/email/verify": { title: "auth.signInTitle", description: "auth.emailSignInDescription" },
}
const signIn = signedInPages[route] ?? { title: "auth.signInTitle" }
function signedIn(): void {
  if (route in signedInPages) void reload()
  else location.assign("/")
}
async function signOut(): Promise<void> { await props.api.logout(); await reload() }
</script>

<template>
  <AuthLayout v-if="isLoading && !state" :title="t('auth.loading')" />
  <AuthLayout v-else-if="error || !state" :title="t('auth.unavailable')">
    <p role="alert" class="m-0 mb-4 break-words text-sm text-ui-danger">{{ failureMessage(error) }}</p>
    <UiButton class="h-9 w-full text-sm" @click="reload()">{{ t("auth.retry") }}</UiButton>
  </AuthLayout>
  <EmailLinkForm v-else-if="route === '/auth/register' || route === '/auth/recovery'" :account="account" :purpose="route === '/auth/register' ? 'register' : 'recovery'" :config="state.config" />
  <SetPasswordForm v-else-if="route === '/auth/verify' || route === '/auth/recovery/complete'" :account="account" :purpose="route === '/auth/verify' ? 'verify' : 'reset'" :token="token" />
  <SignInForm
    v-else-if="!state.user || !(route in signedInPages)"
    :account="account"
    :title="t(signIn.title)"
    :description="signIn.description && t(signIn.description)"
    :registration-enabled="state.config.registrationEnabled"
    :new-tab="signIn.newTab"
    @signed-in="signedIn"
  />
  <DesktopApproval v-else-if="route === '/auth/desktop'" :account="account" :user="state.user" :attempt="attempt" :sign-out="signOut" />
  <EmailChangeConfirm v-else-if="route === '/auth/email/verify'" :account="account" :user="state.user" :token="token" />
  <AccountSecurity v-else :account="account" :user="state.user" />
</template>
