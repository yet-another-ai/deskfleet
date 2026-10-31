<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core"
import { KeyRound } from "@lucide/vue"
import { DialogDescription, DialogTitle } from "reka-ui"
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import type { AccountAuthentication, AuthenticationMethods } from "@deskfleet/client/account-security"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import UiField from "../common/UiField.vue"

/** Offers the account’s available identity proofs for a sensitive action. */
const props = defineProps<{
  reauthenticate(password?: string): Promise<void>
  sendEmailCode: AccountAuthentication["sendEmailCode"]
  verifyEmailCode: AccountAuthentication["verifyEmailCode"]
  authenticationMethods: AccountAuthentication["authenticationMethods"]
}>()
const emit = defineEmits<{ settle: [confirmed: boolean] }>()
const { t } = useI18n()
const password = ref("")
const pending = ref(false)
const error = ref<string>()
const methods = ref<AuthenticationMethods>()
const emailChallenge = ref<string>()
const emailCode = ref("")
const resendIn = ref(0)
useIntervalFn(() => { if (resendIn.value > 0) resendIn.value-- }, 1000)

async function sendEmail(): Promise<void> {
  if (pending.value || resendIn.value > 0) return
  pending.value = true
  error.value = undefined
  // Sending consumes a rate-limit slot and can replace the previous proof even
  // when delivery fails; keep the dialog aligned with that server-side state.
  emailChallenge.value = undefined
  emailCode.value = ""
  resendIn.value = 60
  try {
    const sent = await props.sendEmailCode()
    emailChallenge.value = sent.challengeId
    emailCode.value = ""
    resendIn.value = sent.retryAfter
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
async function confirmEmail(): Promise<void> {
  if (pending.value || !emailChallenge.value) return
  pending.value = true
  error.value = undefined
  try {
    await props.verifyEmailCode(emailChallenge.value, emailCode.value.trim())
    emit("settle", true)
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
onMounted(async () => {
  try { methods.value = await props.authenticationMethods() }
  catch (reason) { error.value = failureMessage(reason) }
})

async function confirm(usePasskey: boolean): Promise<void> {
  if (pending.value || (usePasskey ? !methods.value?.passkey : !methods.value?.password)) return
  pending.value = true
  error.value = undefined
  try {
    await props.reauthenticate(usePasskey ? undefined : password.value)
    password.value = ""
    emit("settle", true)
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[24rem]" described :prevent-close="pending" @close="emit('settle', false)">
    <DialogTitle class="ui-dialog-title">{{ t("auth.reauthTitle") }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t("auth.reauthDescription") }}</DialogDescription>
    <form class="mt-5 flex flex-col gap-4" @submit.prevent="emailChallenge ? confirmEmail() : confirm(false)">
      <UiField v-if="!emailChallenge && methods?.password" v-model="password" :label="t('auth.password')" type="password" name="password" autocomplete="current-password" required maxlength="128" :disabled="pending" autofocus />
      <template v-if="emailChallenge">
        <p role="status" class="m-0 text-sm text-ui-text-muted">{{ t("auth.emailCodeSent") }}</p>
        <UiField v-model="emailCode" :label="t('auth.emailCode')" name="verification-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required :disabled="pending" autofocus />
      </template>
      <UiButton :disabled="pending || resendIn > 0" @click="sendEmail">{{ resendIn > 0 ? t("auth.emailCodeResendIn", { seconds: resendIn }) : t(emailChallenge ? "auth.resend" : "auth.useEmailCode") }}</UiButton>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <UiButton v-if="methods?.passkey && passkeysAvailable()" variant="ghost" :disabled="pending" @click="confirm(true)"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.usePasskeyInstead") }}</UiButton>
        <span class="flex-1" />
        <UiButton :disabled="pending" @click="emit('settle', false)">{{ t("catalog.cancel") }}</UiButton>
        <UiButton v-if="emailChallenge || methods?.password" type="submit" variant="primary" :loading="pending">{{ t("auth.confirm") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
