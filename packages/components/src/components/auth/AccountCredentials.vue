<script setup lang="ts">
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import type { AccountUser } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import SettingsRow from "../settings/SettingsRow.vue"
import PasswordField from "./PasswordField.vue"

const props = defineProps<{ account: AccountAuthentication; user: AccountUser; confirmed: RecentAuthentication["confirmed"] }>()
const { t } = useI18n()
const id = useId()
const editing = ref<"email" | "password">()
const email = ref("")
const password = ref("")
const pending = ref(false)
const error = ref<string>()
const emailSentTo = ref<string>()

function edit(field: "email" | "password"): void {
  editing.value = field
  email.value = ""; password.value = ""; error.value = undefined; emailSentTo.value = undefined
}
async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    if (editing.value === "password") {
      await props.confirmed(() => props.account.changePassword(password.value))
      // The server ends every login session, including this one.
      location.assign("/auth/login")
    } else {
      const address = email.value
      await props.confirmed(() => props.account.changeEmail(address))
      emailSentTo.value = address
    }
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("auth.signInMethods") }}</h2>
    <div class="ui-card px-4 shadow-ui-card">
      <SettingsRow :label="t('auth.email')">
        <template #description><span class="break-all">{{ user.email }}</span></template>
        <UiButton @click="edit('email')">{{ t("auth.change") }}</UiButton>
      </SettingsRow>
      <SettingsRow :label="t('auth.password')">
        <template #description>{{ t("auth.passwordRowDescription") }}</template>
        <UiButton @click="edit('password')">{{ t("auth.change") }}</UiButton>
      </SettingsRow>
    </div>
  </section>
  <UiDialog v-if="editing" class="w-[26rem]" described :prevent-close="pending" @close="editing = undefined">
    <DialogTitle class="ui-dialog-title">{{ t(editing === "email" ? "auth.changeEmailTitle" : "auth.changePasswordTitle") }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">
      {{ emailSentTo ? t("auth.changeEmailSent", { email: emailSentTo }) : t(editing === "email" ? "auth.changeEmailDescription" : "auth.changePasswordDescription") }}
    </DialogDescription>
    <div v-if="emailSentTo" class="ui-dialog-actions">
      <UiButton variant="primary" @click="editing = undefined">{{ t("account.done") }}</UiButton>
    </div>
    <form v-else class="mt-5 flex flex-col gap-4" @submit.prevent="submit">
      <label v-if="editing === 'email'" class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.newEmail") }}
        <input v-model="email" class="ui-input" type="email" name="new-email" autocomplete="email" required maxlength="254" :disabled="pending" autofocus />
      </label>
      <PasswordField v-else v-model="password" :label="t('auth.newPassword')" purpose="new" :disabled="pending" autofocus />
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="ui-dialog-actions mt-2">
        <UiButton :disabled="pending" @click="editing = undefined">{{ t("catalog.cancel") }}</UiButton>
        <UiButton type="submit" variant="primary" :loading="pending">{{ t(editing === "email" ? "auth.sendVerification" : "auth.changePassword") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
