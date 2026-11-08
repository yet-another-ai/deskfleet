<script setup lang="ts">
import { DialogDescription, DialogTitle } from "reka-ui"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import SettingsRow from "../settings/SettingsRow.vue"

const props = defineProps<{ account: AccountAuthentication; confirmed: RecentAuthentication["confirmed"] }>()
const { t, locale } = useI18n()
const id = useId()
const formatDate = (value: string) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
const { state, isLoading, error, executeImmediate: load } = useAsyncState(() => props.account.deletionRequest(), { request: null })
const request = computed(() => state.value?.request)
const requesting = ref(false)
const reason = ref("")
const submitting = ref(false)
const actionError = ref<string>()
const cancelling = ref(false)

function start(): void {
  reason.value = ""
  actionError.value = undefined
  requesting.value = true
}
async function submit(): Promise<void> {
  if (submitting.value) return
  if (!reason.value.trim()) { actionError.value = t("auth.deleteAccountReasonRequired"); return }
  submitting.value = true
  actionError.value = undefined
  try {
    await props.confirmed(() => props.account.requestDeletion(reason.value.trim()))
    requesting.value = false
    await load()
  } catch (cause) { actionError.value = failureMessage(cause) }
  finally { submitting.value = false }
}
async function cancel(): Promise<void> {
  await props.confirmed(() => props.account.cancelDeletion())
  await load()
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("auth.deleteAccount") }}</h2>
    <p v-if="isLoading" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
    <div v-else-if="error" class="flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
      <UiButton @click="load()">{{ t("auth.retry") }}</UiButton>
    </div>
    <div v-else class="ui-card">
      <SettingsRow :label="t('auth.deleteAccount')">
        <template #description>
          <template v-if="request?.status === 'pending'">{{ t("auth.deleteAccountPending", { date: formatDate(request.requestedAt) }) }}</template>
          <template v-else-if="request?.status === 'approved'">{{ t("auth.deleteAccountApproved") }}</template>
          <template v-else-if="request?.status === 'rejected'">
            {{ t("auth.deleteAccountRejected", { date: formatDate(request.requestedAt) }) }}
            <template v-if="request.reviewNote"> {{ t("auth.deleteAccountReviewNote", { note: request.reviewNote }) }}</template>
          </template>
          <template v-else>{{ t("auth.deleteAccountDescription") }}</template>
        </template>
        <UiButton v-if="request?.status === 'pending'" variant="danger" @click="cancelling = true">{{ t("auth.cancelDeletionRequest") }}</UiButton>
        <UiButton v-else-if="request?.status !== 'approved'" variant="danger" @click="start">{{ t("auth.requestAccountDeletion") }}</UiButton>
      </SettingsRow>
    </div>
  </section>
  <UiDialog v-if="requesting" class="w-[26rem]" described :prevent-close="submitting" @close="requesting = false">
    <DialogTitle class="ui-dialog-title">{{ t("auth.deleteAccountTitle") }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t("auth.deleteAccountDescription") }}</DialogDescription>
    <form class="mt-5 flex flex-col gap-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.deleteAccountReason") }}
        <textarea v-model="reason" class="ui-input min-h-28 resize-y" name="deletion-reason" maxlength="2000" rows="4" required autofocus />
      </label>
      <p class="m-0 text-[13px] text-ui-text-muted">{{ t("auth.deleteAccountOwnership") }}</p>
      <p v-if="actionError" role="alert" class="m-0 text-sm text-ui-danger">{{ actionError }}</p>
      <div class="ui-dialog-actions mt-2">
        <UiButton :disabled="submitting" @click="requesting = false">{{ t("catalog.cancel") }}</UiButton>
        <UiButton type="submit" variant="danger" :loading="submitting" :disabled="!reason.trim()">{{ t("auth.submitDeletionRequest") }}</UiButton>
      </div>
    </form>
  </UiDialog>
  <ConfirmDialog
    v-if="cancelling"
    :title="t('auth.cancelDeletionTitle')"
    :description="t('auth.cancelDeletionDescription')"
    :confirm-label="t('auth.cancelDeletionRequest')"
    :confirm="cancel"
    @close="cancelling = false"
  />
</template>
