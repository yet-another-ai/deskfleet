<script setup lang="ts">
import { KeyRound } from "@lucide/vue"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import AuthLayout from "./AuthLayout.vue"
import PasswordField from "./PasswordField.vue"

/** Email/password or Passkey sign-in. Desktop approval opens the other steps in a new tab. */
const props = defineProps<{ account: AccountAuthentication; title: string; description?: string; registrationEnabled: boolean; newTab?: boolean }>()
const emit = defineEmits<{ signedIn: [] }>()
const { t } = useI18n()
const email = ref("")
const password = ref("")
const pending = ref<"password" | "passkey">()
const error = ref<string>()
const emailInput = useTemplateRef("email")
const target = props.newTab ? "_blank" : undefined

async function run(method: "password" | "passkey", action: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = method
  error.value = undefined
  try {
    await action()
    password.value = ""
    emit("signedIn")
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = undefined }
}
function submit(): void { void run("password", () => props.account.login(email.value, password.value)) }
function passkey(): void {
  // The server looks up Passkeys by account, so the address comes first.
  if (!emailInput.value?.reportValidity()) return
  void run("passkey", () => props.account.loginWithPasskey(email.value))
}
</script>

<template>
  <AuthLayout :title="title" :description="description">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.email") }}
        <input ref="email" v-model="email" class="ui-input" type="email" name="email" autocomplete="username webauthn" required maxlength="254" :disabled="!!pending" autofocus />
      </label>
      <PasswordField v-model="password" :label="t('auth.password')" purpose="current" :disabled="!!pending">
        <template #aside><a href="/auth/recovery" :target="target" rel="noopener" class="text-[13px] text-ui-text-muted hover:text-ui-text">{{ t("auth.forgot") }}</a></template>
      </PasswordField>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending === 'password'" :disabled="!!pending">{{ t("auth.signIn") }}</UiButton>
      <template v-if="passkeysAvailable()">
        <div class="flex items-center gap-3 text-xs text-ui-text-faint" aria-hidden="true"><span class="h-px flex-1 bg-ui-border" />{{ t("auth.or") }}<span class="h-px flex-1 bg-ui-border" /></div>
        <UiButton class="h-9 text-sm" :loading="pending === 'passkey'" :disabled="!!pending" @click="passkey"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.signInWithPasskey") }}</UiButton>
      </template>
    </form>
    <template v-if="registrationEnabled" #footer>
      <span>{{ t("auth.newHere") }} <a href="/auth/register" :target="target" rel="noopener" class="text-ui-accent hover:underline">{{ t("auth.createAccount") }}</a></span>
    </template>
  </AuthLayout>
</template>
