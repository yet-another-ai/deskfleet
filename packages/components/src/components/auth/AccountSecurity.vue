<script setup lang="ts">
import { ref } from "vue"
import { useAsyncState } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { AccountState } from "@deskfleet/client/central"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { authenticatePasskey, registerPasskey, passkeysAvailable } from "@deskfleet/client/passkeys"
import UiButton from "../common/UiButton.vue"

type LoginSession = { id: string; deviceId: string; createdAt: string; expiresAt: string; current: boolean }
type Passkey = { id: string; name: string; createdAt: number }
const props = defineProps<{ api: HttpCentralClient; account: AccountState }>()
const { t } = useI18n()
const password = ref("")
const newPassword = ref("")
const email = ref("")
const passkeyName = ref("")
const busy = ref(false)
const error = ref("")
const notice = ref("")
const { state, isLoading, error: loadError, executeImmediate } = useAsyncState(async () => ({
  sessions: await props.api.request<LoginSession[]>("GET", "/api/auth/sessions"),
  passkeys: await props.api.request<Passkey[]>("GET", "/api/auth/passkeys"),
}), undefined)
async function run(action: () => Promise<void>) {
  busy.value = true; error.value = ""; notice.value = ""
  try { await action() } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function reauthenticate(passkey = false) {
  await run(async () => {
    if (passkey) await authenticatePasskey(props.api, "reauthenticate")
    else await props.api.request("POST", "/api/auth/reauthenticate", { password: password.value })
    password.value = ""; notice.value = t("auth.confirmed")
  })
}
async function changePassword() {
  await run(async () => { await props.api.request("POST", "/api/auth/password", { password: newPassword.value }); location.assign("/auth/login") })
}
async function changeEmail() {
  await run(async () => { await props.api.request("POST", "/api/auth/email", { email: email.value }); notice.value = t("auth.checkEmail") })
}
async function addPasskey() {
  await run(async () => { await registerPasskey(props.api, passkeyName.value); passkeyName.value = ""; await executeImmediate() })
}
async function renamePasskey(key: Passkey) {
  await run(async () => { await props.api.request("PATCH", `/api/auth/passkeys/${encodeURIComponent(key.id)}`, { name: key.name }); notice.value = t("auth.saved") })
}
async function removePasskey(id: string) {
  await run(async () => { await props.api.request("DELETE", `/api/auth/passkeys/${encodeURIComponent(id)}`); await executeImmediate() })
}
async function revoke(session?: LoginSession) {
  await run(async () => {
    await props.api.request(session ? "DELETE" : "POST", session ? `/api/auth/sessions/${encodeURIComponent(session.id)}` : "/api/auth/sessions/revoke-all", session ? undefined : {})
    if (!session || session.current) location.assign("/auth/login")
    else await executeImmediate()
  })
}
const date = (value: string | number) => new Date(value).toLocaleString()
</script>

<template>
  <div class="grid gap-6">
    <p class="m-0 text-sm text-ui-text-muted">{{ account.user?.email }}</p>
    <p v-if="error || loadError" role="alert" class="m-0 text-sm text-ui-danger">{{ error || String(loadError) }}</p>
    <p v-if="notice" role="status" class="m-0 text-sm">{{ notice }}</p>
    <section class="ui-card grid gap-3 p-5">
      <h2 class="ui-section-title">{{ t("auth.confirmIdentity") }}</h2>
      <p class="m-0 text-sm text-ui-text-muted">{{ t("auth.reauthHint") }}</p>
      <form class="flex flex-wrap gap-2" @submit.prevent="reauthenticate()">
        <input v-model="password" :aria-label="t('auth.currentPassword')" class="ui-input min-w-0 flex-1" type="password" autocomplete="current-password" required maxlength="128">
        <UiButton type="submit" :loading="busy">{{ t("auth.confirm") }}</UiButton>
        <UiButton v-if="passkeysAvailable() && state?.passkeys.length" :disabled="busy" @click="reauthenticate(true)">{{ t("auth.usePasskey") }}</UiButton>
      </form>
    </section>
    <section class="ui-card grid gap-4 p-5">
      <h2 class="ui-section-title">{{ t("auth.credentials") }}</h2>
      <form class="grid gap-2" @submit.prevent="changePassword">
        <label for="new-password" class="text-sm">{{ t("auth.newPassword") }}</label>
        <input id="new-password" v-model="newPassword" class="ui-input" type="password" autocomplete="new-password" required minlength="15" maxlength="128">
        <p class="m-0 text-xs text-ui-text-muted">{{ t("auth.passwordHint") }} {{ t("auth.signOutAfterChange") }}</p>
        <UiButton type="submit" :loading="busy" class="justify-self-start">{{ t("auth.changePassword") }}</UiButton>
      </form>
      <form class="grid gap-2 border-t border-ui-border pt-4" @submit.prevent="changeEmail">
        <label for="new-email" class="text-sm">{{ t("auth.newEmail") }}</label>
        <input id="new-email" v-model="email" class="ui-input" type="email" autocomplete="email" required maxlength="254">
        <UiButton type="submit" :loading="busy" class="justify-self-start">{{ t("auth.sendLink") }}</UiButton>
      </form>
    </section>
    <section class="ui-card grid gap-3 p-5">
      <h2 class="ui-section-title">{{ t("auth.passkeys") }}</h2>
      <p v-if="isLoading" role="status">{{ t("auth.loading") }}</p>
      <p v-else-if="!state?.passkeys.length" class="m-0 text-sm text-ui-text-muted">{{ t("auth.noPasskeys") }}</p>
      <form v-for="key in state?.passkeys" :key="key.id" class="flex flex-wrap gap-2" @submit.prevent="renamePasskey(key)">
        <input v-model="key.name" :aria-label="t('auth.passkeyName')" class="ui-input min-w-0 flex-1" required maxlength="200">
        <UiButton type="submit" :disabled="busy">{{ t("auth.save") }}</UiButton>
        <UiButton :disabled="busy" @click="removePasskey(key.id)">{{ t("auth.remove") }}</UiButton>
      </form>
      <form v-if="passkeysAvailable()" class="flex flex-wrap gap-2" @submit.prevent="addPasskey">
        <input v-model="passkeyName" :aria-label="t('auth.passkeyName')" :placeholder="t('auth.passkeyName')" class="ui-input min-w-0 flex-1" required maxlength="200">
        <UiButton type="submit" :loading="busy">{{ t("auth.addPasskey") }}</UiButton>
      </form>
      <p v-else class="text-sm text-ui-text-muted">{{ t("auth.passkeysUnavailable") }}</p>
    </section>
    <section class="ui-card grid gap-3 p-5">
      <div class="flex items-center justify-between gap-3"><h2 class="ui-section-title">{{ t("auth.sessions") }}</h2><UiButton :disabled="busy" @click="executeImmediate()">{{ t("auth.refresh") }}</UiButton></div>
      <div v-for="session in state?.sessions" :key="session.id" class="flex items-center justify-between gap-3 border-t border-ui-border pt-3">
        <div class="min-w-0 text-sm"><p class="m-0 font-medium">{{ session.current ? t("auth.thisSession") : t("auth.otherSession") }}</p><p class="m-0 mt-1 text-xs text-ui-text-muted">{{ t("auth.sessionCreated", { date: date(session.createdAt) }) }}</p><p class="m-0 mt-1 text-xs text-ui-text-muted">{{ t("auth.sessionExpires", { date: date(session.expiresAt) }) }}</p></div>
        <UiButton :disabled="busy" @click="revoke(session)">{{ t("auth.revoke") }}</UiButton>
      </div>
      <UiButton variant="danger" :disabled="busy" class="justify-self-start" @click="revoke()">{{ t("auth.revokeAll") }}</UiButton>
    </section>
    <a href="/" class="text-sm">{{ t("auth.back") }}</a>
  </div>
</template>
