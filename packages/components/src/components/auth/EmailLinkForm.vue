<script setup lang="ts">
import { MailCheck } from "@lucide/vue"
import { useTimeoutFn } from "@vueuse/core"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import AuthLayout from "./AuthLayout.vue"

/** Registration and recovery both start by mailing a one-hour link; sending again is the resend. */
const props = defineProps<{ account: AccountAuthentication; purpose: "register" | "recovery"; registrationEnabled: boolean }>()
const { t } = useI18n()
const email = ref("")
const sentTo = ref<string>()
const pending = ref(false)
const error = ref<string>()
const resent = ref(false)
// The server rate-limits mail too; this keeps an impatient second click from spending that budget.
const { isPending: cooling, start: cool } = useTimeoutFn(() => {}, 30_000, { immediate: false })
const copy = props.purpose === "register"
  ? { title: "auth.registerTitle", description: "auth.registerDescription", submit: "auth.continue", sent: "auth.registerSent" }
  : { title: "auth.recoveryTitle", description: "auth.recoveryDescription", submit: "auth.sendResetLink", sent: "auth.recoverySent" }

async function send(again = false): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    const address = again ? sentTo.value! : email.value
    await (props.purpose === "register" ? props.account.register(address) : props.account.requestRecovery(address))
    sentTo.value = address
    resent.value = again
    cool()
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
function restart(): void { sentTo.value = undefined; resent.value = false; error.value = undefined }
</script>

<template>
  <AuthLayout v-if="purpose === 'register' && !registrationEnabled" :title="t('auth.registerTitle')">
    <p role="status" class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t("auth.registrationClosed") }}</p>
    <template #footer><a href="/auth/login" class="hover:text-ui-text">{{ t("auth.backToSignIn") }}</a></template>
  </AuthLayout>
  <AuthLayout v-else-if="sentTo" :icon="MailCheck" :title="t('auth.checkInbox')" :description="t(copy.sent, { email: sentTo })">
    <div class="flex flex-col gap-3">
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <p v-else-if="resent" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("auth.sentAgain") }}</p>
      <UiButton class="h-9 text-sm" :loading="pending" :disabled="cooling" @click="send(true)">{{ t("auth.resend") }}</UiButton>
      <UiButton variant="ghost" class="h-9 text-sm" :disabled="pending" @click="restart">{{ t("auth.differentEmail") }}</UiButton>
    </div>
    <template #footer><a href="/auth/login" class="hover:text-ui-text">{{ t("auth.backToSignIn") }}</a></template>
  </AuthLayout>
  <AuthLayout v-else :title="t(copy.title)" :description="t(copy.description)">
    <form class="flex flex-col gap-4" @submit.prevent="send()">
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.email") }}
        <input v-model="email" class="ui-input" type="email" name="email" autocomplete="email" required maxlength="254" :disabled="pending" autofocus />
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending">{{ t(copy.submit) }}</UiButton>
    </form>
    <template #footer>
      <span v-if="purpose === 'register'">{{ t("auth.haveAccount") }} <a href="/auth/login" class="text-ui-accent hover:underline">{{ t("auth.signIn") }}</a></span>
      <a v-else href="/auth/login" class="hover:text-ui-text">{{ t("auth.backToSignIn") }}</a>
    </template>
  </AuthLayout>
</template>
