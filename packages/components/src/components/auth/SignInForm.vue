<script setup lang="ts">
import { KeyRound } from "@lucide/vue"
import githubIcon from "@lobehub/icons-static-svg/icons/github.svg?url"
import { computed, nextTick, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication, AuthConfig } from "@deskfleet/client/account-security"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
// Official sign-in mark: https://developers.google.com/identity/branding-guidelines
import googleIcon from "../../assets/google.png"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import UiField from "../common/UiField.vue"
import AuthLayout from "./AuthLayout.vue"

/** Account sign-in. Desktop approval opens the other steps in a new tab. */
const props = defineProps<{ account: AccountAuthentication; title: string; description?: string; registrationEnabled: boolean; newTab?: boolean; config: AuthConfig; returnTo: string; githubError?: string; googleError?: string; emailVerificationToken?: string }>()
const emit = defineEmits<{ signedIn: [] }>()
const { t } = useI18n()
const email = ref("")
const password = ref("")
type OAuthProvider = "github" | "google"
const pending = ref<"password" | "passkey" | OAuthProvider>()
const oauthErrors: Record<string, string> = { failed: "Failed", registration_disabled: "RegistrationDisabled", terms_required: "TermsRequired", email_conflict: "EmailConflict" }
const callbackProvider = props.googleError ? "google" : "github"
const callbackError = props.googleError ?? props.githubError
const error = ref<string | undefined>(callbackError ? t(`auth.${callbackProvider}${oauthErrors[callbackError] ?? "Failed"}`) : undefined)
const acceptedTerms = ref(false)
const termsAttempted = ref<OAuthProvider>()
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
async function oauth(provider: OAuthProvider): Promise<void> {
  if (pending.value) return
  if (termsRequired.value && !acceptedTerms.value) {
    termsAttempted.value = provider
    shakeTerms.value = false
    await nextTick()
    shakeTerms.value = true
    return
  }
  pending.value = provider
  error.value = undefined
  try {
    if (props.emailVerificationToken) sessionStorage.setItem("deskfleet-email-verify-token", props.emailVerificationToken)
    const start = provider === "github" ? props.account.startGithub : props.account.startGoogle
    const { authorizationUrl } = await start(props.returnTo, acceptedTerms.value)
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
      <UiField v-model="password" :label="t('auth.password')" type="password" name="password" autocomplete="current-password" required maxlength="128" :disabled="!!pending">
        <template #aside><a href="/auth/recovery" :target="target" rel="noopener" class="text-[13px] text-ui-text-muted hover:text-ui-text">{{ t("auth.forgot") }}</a></template>
      </UiField>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending === 'password'" :disabled="!!pending">{{ t("auth.signIn") }}</UiButton>
      <template v-if="passkeysAvailable() || config.githubEnabled || config.googleEnabled">
        <div class="flex items-center gap-3 text-xs text-ui-text-faint" aria-hidden="true"><span class="h-px flex-1 bg-ui-border" />{{ t("auth.or") }}<span class="h-px flex-1 bg-ui-border" /></div>
        <UiButton v-if="passkeysAvailable()" class="h-9 text-sm" :loading="pending === 'passkey'" :disabled="!!pending" @click="passkey"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.signInWithPasskey") }}</UiButton>
        <div v-if="(config.githubEnabled || config.googleEnabled) && termsRequired">
          <div class="flex items-start gap-2.5 text-sm leading-relaxed text-ui-text-muted" :class="{ 'terms-shake': shakeTerms }" @animationend="shakeTerms = false">
            <UiCheckbox :id="`${id}-oauth-terms`" v-model="acceptedTerms" :aria-labelledby="`${id}-oauth-terms-label`" :aria-invalid="termsAttempted && !acceptedTerms ? 'true' : undefined" :aria-describedby="termsAttempted && !acceptedTerms ? `${id}-oauth-terms-error` : undefined" :disabled="!!pending" class="mt-1" />
            <span :id="`${id}-oauth-terms-label`">
              <label :for="`${id}-oauth-terms`">{{ `${t("auth.agreeToTerms")} ` }}</label>
              <a v-if="config.termsOfServiceUrl" :href="config.termsOfServiceUrl" target="_blank" rel="noopener noreferrer" class="text-ui-accent hover:underline">{{ t("auth.termsOfService") }}</a>
              <template v-if="config.termsOfServiceUrl && config.privacyTermsUrl">{{ ` ${t("auth.termsAnd")} ` }}</template>
              <a v-if="config.privacyTermsUrl" :href="config.privacyTermsUrl" target="_blank" rel="noopener noreferrer" class="text-ui-accent hover:underline">{{ t("auth.privacyTerms") }}</a>
            </span>
          </div>
          <p v-if="termsAttempted && !acceptedTerms" :id="`${id}-oauth-terms-error`" role="alert" class="m-0 mt-1 text-sm text-ui-danger">{{ t(`auth.${termsAttempted}TermsRequired`) }}</p>
        </div>
        <UiButton v-if="config.githubEnabled" class="github-sign-in h-9 text-sm" :loading="pending === 'github'" :disabled="!!pending" @click="oauth('github')">
          <span class="github-icon" :style="githubIconStyle" aria-hidden="true" />{{ t("auth.signInWithGithub") }}
        </UiButton>
        <UiButton v-if="config.googleEnabled" class="google-sign-in h-9 text-sm" :loading="pending === 'google'" :disabled="!!pending" @click="oauth('google')">
          <img :src="googleIcon" class="google-icon" alt="" />{{ t("auth.signInWithGoogle") }}
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
.google-sign-in { gap: 10px; color: #1f1f1f; background: #fff; border-color: #747775; font-family: "Google Sans", sans-serif; font-weight: 500; }
.google-sign-in:enabled:hover { background: #f2f2f2; }
.google-sign-in:enabled:active { background: #e3e3e3; }
.google-icon { width: 18px; height: auto; flex: none; }
@media (prefers-reduced-motion: no-preference) {
  .terms-shake { animation: terms-shake 360ms ease-in-out; }
  @keyframes terms-shake {
    25%, 75% { transform: translateX(-4px); }
    50% { transform: translateX(4px); }
  }
}
</style>
