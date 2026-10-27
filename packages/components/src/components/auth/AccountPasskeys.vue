<script setup lang="ts">
import { KeyRound, Pencil, Plus, Trash2 } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { DialogTitle } from "reka-ui"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication, Passkey } from "@deskfleet/client/account-security"
import { passkeysAvailable } from "@deskfleet/client/passkeys"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import IconButton from "../common/IconButton.vue"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{ account: AccountAuthentication; confirmed: RecentAuthentication["confirmed"]; formatDate(value: string | number): string }>()
const { t } = useI18n()
const id = useId()
const supported = passkeysAvailable()
const { state: passkeys, isLoading, error: loadError, executeImmediate: load } = useAsyncState(() => props.account.passkeys(), [])
/** The Passkey being named: a new one has no id yet. */
const naming = ref<{ key?: Passkey; name: string }>()
const removing = ref<Passkey>()
const pending = ref(false)
const error = ref<string>()

function name(key?: Passkey): void { naming.value = { key, name: key?.name ?? "" }; error.value = undefined }
async function save(): Promise<void> {
  if (pending.value || !naming.value) return
  const { key, name } = naming.value
  pending.value = true
  error.value = undefined
  try {
    await props.confirmed(() => key ? props.account.renamePasskey(key.id, name.trim()) : props.account.addPasskey(name.trim()))
    naming.value = undefined
    await load()
  } catch (reason) { error.value = failureMessage(reason) }
  finally { pending.value = false }
}
async function remove(key: Passkey): Promise<void> {
  await props.confirmed(() => props.account.removePasskey(key.id))
  passkeys.value = passkeys.value.filter(value => value.id !== key.id)
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <div class="ui-section-header">
      <h2 :id="`${id}-title`" class="ui-section-title">{{ t("auth.passkeys") }}</h2>
      <UiButton v-if="supported" :disabled="isLoading" @click="name()"><Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("auth.addPasskey") }}</UiButton>
    </div>
    <p v-if="!supported" class="m-0 mb-2 text-[13px] text-ui-text-muted">{{ t("auth.passkeysUnavailable") }}</p>
    <p v-if="isLoading" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
    <div v-else-if="loadError" class="flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(loadError) }}</p>
      <UiButton @click="load()">{{ t("auth.retry") }}</UiButton>
    </div>
    <div v-else-if="!passkeys.length" class="ui-empty">
      <KeyRound :size="20" :stroke-width="1.5" class="mb-1 text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm font-medium">{{ t("auth.noPasskeys") }}</p>
      <p class="m-0 max-w-xs text-[13px] text-ui-text-muted">{{ t("auth.noPasskeysDescription") }}</p>
    </div>
    <ul v-else class="ui-card m-0 list-none p-0 shadow-ui-card">
      <li v-for="key in passkeys" :key="key.id" class="ui-card-row py-3">
        <KeyRound :size="16" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{{ key.name }}</div>
          <div class="text-[13px] text-ui-text-muted">{{ t("auth.added", { date: formatDate(key.createdAt) }) }}</div>
        </div>
        <IconButton :icon="Pencil" :label="t('auth.renamePasskeyLabel', { name: key.name })" @click="name(key)" />
        <IconButton :icon="Trash2" :label="t('auth.removePasskeyLabel', { name: key.name })" @click="removing = key" />
      </li>
    </ul>
  </section>
  <UiDialog v-if="naming" class="w-[24rem]" :prevent-close="pending" @close="naming = undefined">
    <DialogTitle class="ui-dialog-title">{{ t(naming.key ? "auth.renamePasskey" : "auth.addPasskey") }}</DialogTitle>
    <form class="mt-5 flex flex-col gap-4" @submit.prevent="save">
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("auth.passkeyName") }}
        <input v-model="naming.name" class="ui-input" name="passkey-name" required maxlength="200" autocomplete="off" :placeholder="t('auth.passkeyNamePlaceholder')" :disabled="pending" autofocus />
      </label>
      <p v-if="!naming.key" class="m-0 text-[13px] text-ui-text-muted">{{ t("auth.addPasskeyDescription") }}</p>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="ui-dialog-actions mt-2">
        <UiButton :disabled="pending" @click="naming = undefined">{{ t("catalog.cancel") }}</UiButton>
        <UiButton type="submit" variant="primary" :loading="pending">{{ t(naming.key ? "catalog.save" : "auth.continue") }}</UiButton>
      </div>
    </form>
  </UiDialog>
  <ConfirmDialog
    v-if="removing"
    :title="t('auth.removePasskeyTitle', { name: removing.name })"
    :description="t('auth.removePasskeyDescription')"
    :confirm-label="t('auth.remove')"
    :confirm="() => remove(removing!)"
    @close="removing = undefined"
  />
</template>
