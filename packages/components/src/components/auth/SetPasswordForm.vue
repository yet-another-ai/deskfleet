<script setup lang="ts">
import { CircleCheck, Link2Off } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import AuthLayout from "./AuthLayout.vue"
import PasswordField from "./PasswordField.vue"

/** Completes a mailed link: a verified registration names its account; recovery replaces the password. */
const props = defineProps<{ account: AccountAuthentication; purpose: "verify" | "reset"; token?: string }>()
const { t } = useI18n()
const name = ref("")
const password = ref("")
const pending = ref(false)
const error = ref<string>()
const reset = ref(false)
const restart = props.purpose === "verify" ? "/auth/register" : "/auth/recovery"

async function submit(): Promise<void> {
  if (pending.value || !props.token) return
  pending.value = true
  error.value = undefined
  try {
    if (props.purpose === "verify") {
      await props.account.verify(props.token, name.value.trim(), password.value)
      location.assign("/")
    } else {
      await props.account.completeRecovery(props.token, password.value)
      reset.value = true
    }
    password.value = ""
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <AuthLayout v-if="!token" :icon="Link2Off" :title="t('auth.linkInvalid')" :description="t('auth.linkInvalidDescription')">
    <a :href="restart" class="ui-button-primary h-9 w-full text-sm">{{ t("auth.requestNewLink") }}</a>
  </AuthLayout>
  <AuthLayout v-else-if="reset" :icon="CircleCheck" :title="t('auth.passwordReset')" :description="t('auth.passwordResetDescription')">
    <a href="/auth/login" class="ui-button-primary h-9 w-full text-sm">{{ t("auth.signIn") }}</a>
  </AuthLayout>
  <AuthLayout v-else :title="t(purpose === 'verify' ? 'auth.verifyTitle' : 'auth.resetTitle')" :description="t(purpose === 'verify' ? 'auth.verifyDescription' : 'auth.resetDescription')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <label v-if="purpose === 'verify'" class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.name") }}
        <input v-model="name" class="ui-input" name="name" autocomplete="name" required maxlength="200" :disabled="pending" autofocus />
      </label>
      <PasswordField v-model="password" :label="t(purpose === 'verify' ? 'auth.password' : 'auth.newPassword')" purpose="new" :disabled="pending" :autofocus="purpose === 'reset'" />
      <div v-if="error" role="alert" class="m-0 text-sm text-ui-danger">
        {{ error }} <a :href="restart" class="text-ui-accent hover:underline">{{ t("auth.requestNewLink") }}</a>
      </div>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending">{{ t(purpose === "verify" ? "auth.createAccount" : "auth.resetPassword") }}</UiButton>
    </form>
  </AuthLayout>
</template>
