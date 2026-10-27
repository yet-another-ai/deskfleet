<script setup lang="ts">
import { KeyRound } from "@lucide/vue"
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import PasswordField from "./PasswordField.vue"

/** Asks for a fresh password or Passkey proof, then lets the waiting action retry. */
const props = defineProps<{ reauthenticate(password?: string): Promise<void> }>()
const emit = defineEmits<{ settle: [confirmed: boolean] }>()
const { t } = useI18n()
const password = ref("")
const pending = ref(false)
const error = ref<string>()

async function confirm(usePasskey: boolean): Promise<void> {
  if (pending.value) return
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
    <form class="mt-5 flex flex-col gap-4" @submit.prevent="confirm(false)">
      <PasswordField v-model="password" :label="t('auth.password')" purpose="current" :disabled="pending" autofocus />
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <UiButton v-if="passkeysAvailable()" variant="ghost" :disabled="pending" @click="confirm(true)"><KeyRound :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.usePasskeyInstead") }}</UiButton>
        <span class="flex-1" />
        <UiButton :disabled="pending" @click="emit('settle', false)">{{ t("catalog.cancel") }}</UiButton>
        <UiButton type="submit" variant="primary" :loading="pending">{{ t("auth.confirm") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
