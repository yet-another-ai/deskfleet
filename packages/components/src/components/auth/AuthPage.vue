<script setup lang="ts">
import { ref, computed } from "vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { HttpError, type HttpCentralClient } from "@deskfleet/client/http-central"
import { authenticatePasskey, passkeysAvailable } from "@deskfleet/client/passkeys"
import UiButton from "../common/UiButton.vue"
import AccountSecurity from "./AccountSecurity.vue"

const props = defineProps<{ api: HttpCentralClient }>()
const { t } = useI18n()
const route = location.pathname.replace(/\/$/, "")
const attempt = new URLSearchParams(location.search).get("attempt")
const token = new URLSearchParams(location.hash.slice(1)).get("token")
if (token) history.replaceState(null, "", location.pathname + location.search)
const email = ref("")
const password = ref("")
const name = ref("")
const busy = ref(false)
const needsReauth = ref(false)
const error = ref("")
const notice = ref("")
const { state, isLoading, error: loadError, executeImmediate } = useAsyncState(async () => ({
  config: await props.api.request<{ registrationEnabled: boolean }>("GET", "/api/auth/config"),
  account: await props.api.status(),
}), undefined)
const isDesktop = route === "/auth/desktop"
useEventListener(window, "focus", () => { if (isDesktop) void executeImmediate() })
const isLogin = computed(() => route === "/auth/login" || (isDesktop && !state.value?.account.user) || (["/auth/account", "/auth/email/verify"].includes(route) && !state.value?.account.user))
const isRegister = route === "/auth/register"
const isVerify = route === "/auth/verify"
const isRecovery = route === "/auth/recovery"
const isReset = route === "/auth/recovery/complete"
const isEmail = route === "/auth/email/verify"
const title = computed(() => t(isLogin.value ? "auth.signIn" : isRegister ? "auth.register" : isVerify ? "auth.verify" : isRecovery || isReset ? "auth.recover" : isEmail ? "auth.changeEmail" : isDesktop ? "auth.desktop" : "auth.security"))
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = ""; notice.value = ""
  try { await action() } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    if (reason instanceof HttpError && reason.code === "recent_authentication_required") needsReauth.value = true
  }
  finally { busy.value = false }
}
async function signedIn() {
  if (isDesktop || isEmail || route === "/auth/account") await executeImmediate()
  else location.assign("/")
}
async function submit() {
  await run(async () => {
    if (isLogin.value) {
      await props.api.request("POST", "/api/auth/login", { email: email.value, password: password.value })
      password.value = ""; await signedIn()
    } else if (isRegister || isRecovery) {
      await props.api.request("POST", isRegister ? "/api/auth/register" : "/api/auth/recovery", { email: email.value })
      notice.value = t("auth.checkEmail")
    } else if (isVerify || isReset) {
      if (!token) throw new Error(t("auth.missingToken"))
      await props.api.request("POST", isVerify ? "/api/auth/verify" : "/api/auth/recovery/complete", { token, password: password.value, ...(isVerify ? { name: name.value } : {}) })
      password.value = ""
      location.assign(isVerify ? "/" : "/auth/login")
    } else if (isEmail) {
      if (!token) throw new Error(t("auth.missingToken"))
      await props.api.request("POST", "/api/auth/email/verify", { token })
      notice.value = t("auth.emailChanged")
    } else if (isDesktop && attempt) {
      if (needsReauth.value) {
        await props.api.request("POST", "/api/auth/reauthenticate", { password: password.value })
        password.value = ""; needsReauth.value = false
      }
      const { returnTo } = await props.api.request<{ returnTo: string }>("POST", "/api/auth/desktop/complete", { attempt })
      location.assign(returnTo)
    }
  })
}
async function passkey() {
  await run(async () => {
    if (needsReauth.value) { await authenticatePasskey(props.api, "reauthenticate"); needsReauth.value = false; notice.value = t("auth.confirmed") }
    else { await authenticatePasskey(props.api, "login", email.value); await signedIn() }
  })
}
</script>

<template>
  <main class="min-h-screen bg-ui-base px-5 py-12 text-ui-text">
    <div :class="['mx-auto w-full', route === '/auth/account' && state?.account.user ? 'max-w-2xl' : 'max-w-sm']">
      <a href="/" class="text-lg font-semibold text-ui-text no-underline">deskfleet</a>
      <h1 class="ui-page-title mb-6 mt-8">{{ title }}</h1>
      <p v-if="isLoading" role="status">{{ t("auth.loading") }}</p>
      <div v-else-if="loadError" role="alert"><p>{{ String(loadError) }}</p><UiButton @click="executeImmediate()">{{ t("auth.retry") }}</UiButton></div>
      <AccountSecurity v-else-if="route === '/auth/account' && state?.account.user" :api="api" :account="state.account" />
      <template v-else-if="state">
        <p v-if="isRegister && !state.config.registrationEnabled" role="status">{{ t("auth.registrationClosed") }}</p>
        <form v-else class="grid gap-4" @submit.prevent="submit">
          <p v-if="isDesktop && state.account.user" class="text-sm text-ui-text-muted">{{ t("auth.desktopConfirm", { email: state.account.user.email }) }}</p>
          <label v-if="isLogin || isRegister || isRecovery" class="grid gap-1.5 text-sm">{{ t("auth.email") }}<input v-model="email" class="ui-input" type="email" autocomplete="username" required maxlength="254"></label>
          <label v-if="isVerify" class="grid gap-1.5 text-sm">{{ t("auth.name") }}<input v-model="name" class="ui-input" autocomplete="name" required maxlength="200"></label>
          <label v-if="isLogin || isVerify || isReset || needsReauth" class="grid gap-1.5 text-sm">{{ t("auth.password") }}<input v-model="password" class="ui-input" type="password" :autocomplete="isLogin || needsReauth ? 'current-password' : 'new-password'" required :minlength="isLogin ? undefined : 15" maxlength="128"><span v-if="!isLogin && !needsReauth" class="text-xs text-ui-text-muted">{{ t("auth.passwordHint") }}</span></label>
          <UiButton type="submit" variant="primary" :loading="busy">{{ isRegister || isRecovery ? t("auth.sendLink") : isDesktop && state.account.user ? t("auth.continueDesktop") : isEmail ? t("auth.confirmEmail") : title }}</UiButton>
          <UiButton v-if="(isLogin || needsReauth) && passkeysAvailable()" :disabled="(!needsReauth && !email) || busy" @click="passkey">{{ t("auth.usePasskey") }}</UiButton>
        </form>
        <p v-if="error" role="alert" class="mt-4 text-sm text-ui-danger">{{ error }}</p>
        <p v-if="notice" role="status" class="mt-4 text-sm text-ui-text-muted">{{ notice }}</p>
        <nav class="mt-6 flex flex-wrap gap-4 text-sm">
          <a v-if="!isLogin" href="/auth/login">{{ t("auth.signIn") }}</a>
          <a v-if="isLogin && state.config.registrationEnabled" href="/auth/register" :target="isDesktop ? '_blank' : undefined" rel="noopener">{{ t("auth.register") }}</a>
          <a v-if="isLogin" href="/auth/recovery" :target="isDesktop ? '_blank' : undefined" rel="noopener">{{ t("auth.forgot") }}</a>
          <a v-if="isEmail" href="/auth/account">{{ t("auth.security") }}</a>
        </nav>
      </template>
    </div>
  </main>
</template>
