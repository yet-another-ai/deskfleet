<script setup lang="ts">
import { KeyRound } from "@lucide/vue"
import githubIcon from "@lobehub/icons-static-svg/icons/github.svg?url"
import { computed, nextTick, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication, AuthConfig } from "@deskfleet/client/account-security"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import AuthLayout from "./AuthLayout.vue"
import PasswordField from "./PasswordField.vue"

/** Email/password or Passkey sign-in. Desktop approval opens the other steps in a new tab. */
const props = defineProps<{ account: AccountAuthentication; title: string; description?: string; registrationEnabled: boolean; newTab?: boolean; config: AuthConfig; returnTo: string; githubError?: string; emailVerificationToken?: string }>()
const emit = defineEmits<{ signedIn: [] }>()
const { t } = useI18n()
const email = ref("")
const password = ref("")
const pending = ref<"password" | "passkey" | "github">()
const githubErrors: Record<string, string> = { failed: "auth.githubFailed", registration_disabled: "auth.githubRegistrationDisabled", terms_required: "auth.githubTermsRequired", email_conflict: "auth.githubEmailConflict" }
const error = ref<string | undefined>(props.githubError ? t(githubErrors[props.githubError] ?? "auth.githubFailed") : undefined)
const acceptedTerms = ref(false)
const termsAttempted = ref(false)
const shakeTerms = ref(false)
const termsRequired = computed(() => !!(props.config.termsOfServiceUrl || props.config.privacyTermsUrl))
const githubIconStyle = { maskImage: `url("${githubIcon}")` }
const id = useId()
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
async function github(): Promise<void> {
  if (pending.value) return
  if (termsRequired.value && !acceptedTerms.value) {
    termsAttempted.value = true
    shakeTerms.value = false
    await nextTick()
    shakeTerms.value = true
    return
  }
  pending.value = "github"
  error.value = undefined
  try {
    if (props.emailVerificationToken) sessionStorage.setItem("deskfleet-email-verify-token", props.emailVerificationToken)
    const { authorizationUrl } = await props.account.startGithub(props.returnTo, acceptedTerms.value)
    location.assign(authorizationUrl)
  } catch (reason) { sessionStorage.removeItem("deskfleet-email-verify-token"); error.value = failureMessage(reason); pending.value = undefined }
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
      <template v-if="passkeysAvailable() || config.githubEnabled">
        <div class="flex items-center gap-3 text-xs text-ui-text-faint" aria-hidden="true"><span class="h-px flex-1 bg-ui-border" />{{ t("auth.or") }}<span class="h-px flex-1 bg-ui-border" /></div>
        <UiButton v-if="passkeysAvailable()" class="h-9 text-sm" :loading="pending === 'passkey'" :disabled="!!pending" @click="passkey"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.signInWithPasskey") }}</UiButton>
        <div v-if="config.githubEnabled && termsRequired">
          <div class="flex items-start gap-2.5 text-sm leading-relaxed text-ui-text-muted" :class="{ 'terms-shake': shakeTerms }" @animationend="shakeTerms = false">
            <UiCheckbox :id="`${id}-github-terms`" v-model="acceptedTerms" :aria-labelledby="`${id}-github-terms-label`" :aria-invalid="termsAttempted && !acceptedTerms ? 'true' : undefined" :aria-describedby="termsAttempted && !acceptedTerms ? `${id}-github-terms-error` : undefined" :disabled="!!pending" class="mt-1" />
            <span :id="`${id}-github-terms-label`">
              <label :for="`${id}-github-terms`">{{ `${t("auth.agreeToTerms")} ` }}</label>
              <a v-if="config.termsOfServiceUrl" :href="config.termsOfServiceUrl" target="_blank" rel="noopener noreferrer" class="text-ui-accent hover:underline">{{ t("auth.termsOfService") }}</a>
              <template v-if="config.termsOfServiceUrl && config.privacyTermsUrl">{{ ` ${t("auth.termsAnd")} ` }}</template>
              <a v-if="config.privacyTermsUrl" :href="config.privacyTermsUrl" target="_blank" rel="noopener noreferrer" class="text-ui-accent hover:underline">{{ t("auth.privacyTerms") }}</a>
            </span>
          </div>
          <p v-if="termsAttempted && !acceptedTerms" :id="`${id}-github-terms-error`" role="alert" class="m-0 mt-1 text-sm text-ui-danger">{{ t("auth.githubTermsRequired") }}</p>
        </div>
        <UiButton v-if="config.githubEnabled" class="github-sign-in h-9 text-sm" :loading="pending === 'github'" :disabled="!!pending" @click="github">
          <span class="github-icon" :style="githubIconStyle" aria-hidden="true" />{{ t("auth.signInWithGithub") }}
        </UiButton>
      </template>
    </form>
    <template v-if="registrationEnabled" #footer>
      <span>{{ t("auth.newHere") }} <a href="/auth/register" :target="target" rel="noopener" class="text-ui-accent hover:underline">{{ t("auth.createAccount") }}</a></span>
    </template>
  </AuthLayout>
</template>

<style scoped>
.github-sign-in { color: #fff; background: #24292f; border-color: #24292f; }
.github-sign-in:enabled:hover { background: #32383f; }
.github-sign-in:enabled:active { background: #1b1f23; }
.github-icon { width: 16px; height: 16px; flex: none; background: currentColor; mask-size: contain; mask-position: center; mask-repeat: no-repeat; }
@media (prefers-reduced-motion: no-preference) {
  .terms-shake { animation: terms-shake 360ms ease-in-out; }
  @keyframes terms-shake {
    25%, 75% { transform: translateX(-4px); }
    50% { transform: translateX(4px); }
  }
}
</style>
