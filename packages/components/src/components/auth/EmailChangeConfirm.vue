<script setup lang="ts">
import { CircleCheck, Link2Off, Mail } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import type { AccountUser } from "@deskfleet/client/central"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import AuthLayout from "./AuthLayout.vue"

/** Applies a verified email change for the signed-in owner. The server then ends this login session. */
const props = defineProps<{ account: AccountAuthentication; user: AccountUser; token?: string }>()
const { t } = useI18n()
const pending = ref(false)
const error = ref<string>()
const changed = ref(false)

async function confirm(): Promise<void> {
  if (pending.value || !props.token) return
  pending.value = true
  error.value = undefined
  try { await props.account.confirmEmail(props.token); changed.value = true }
  catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <AuthLayout v-if="!token" :icon="Link2Off" :title="t('auth.linkInvalid')" :description="t('auth.linkInvalidDescription')">
    <a href="/auth/account" class="ui-button-primary h-9 w-full text-sm">{{ t("auth.security") }}</a>
  </AuthLayout>
  <AuthLayout v-else-if="changed" :icon="CircleCheck" :title="t('auth.emailChanged')" :description="t('auth.emailChangedDescription')">
    <a href="/auth/login" class="ui-button-primary h-9 w-full text-sm">{{ t("auth.signIn") }}</a>
  </AuthLayout>
  <AuthLayout v-else :icon="Mail" :title="t('auth.confirmEmailTitle')" :description="t('auth.confirmEmailDescription', { email: user.email })">
    <form class="flex flex-col gap-4" @submit.prevent="confirm">
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <UiButton type="submit" variant="primary" class="h-9 text-sm" :loading="pending">{{ t("auth.confirmEmail") }}</UiButton>
    </form>
  </AuthLayout>
</template>
