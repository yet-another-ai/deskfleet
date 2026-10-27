<script setup lang="ts">
import { Search } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import UserAvatar from "../common/UserAvatar.vue"
import SettingsRow from "./SettingsRow.vue"

type User = Awaited<ReturnType<SiteAdministrationApi["users"]>>[number]
const props = defineProps<{ api: SiteAdministrationApi; confirmed: RecentAuthentication["confirmed"] }>()
const { t } = useI18n()
const id = useId()
const query = ref("")
const results = ref<{ query: string; users: User[] }>()
const searching = ref(false)
const pending = ref<string>()
const actionError = ref<string>()
const disabling = ref<User>()
const { state: policy, error: policyError } = useAsyncState(() => props.api.registrationPolicy(), undefined)
// The server returns at most this many matches.
const resultLimit = 50

async function run(key: string, action: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = key
  actionError.value = undefined
  try { await action() } catch (reason) { actionError.value = failureMessage(reason) }
  finally { pending.value = undefined }
}
function setRegistration(enabled: boolean): void {
  void run("registration", async () => {
    await props.confirmed(() => props.api.updateRegistration(enabled))
    policy.value = { registrationEnabled: enabled }
  })
}
async function search(): Promise<void> {
  if (searching.value) return
  searching.value = true
  actionError.value = undefined
  try { results.value = { query: query.value.trim(), users: await props.api.users(query.value.trim()) } }
  catch (reason) { actionError.value = failureMessage(reason) }
  finally { searching.value = false }
}
async function setDisabled(user: User, disabled: boolean): Promise<void> {
  await props.confirmed(() => props.api.disableUser(user.id, disabled))
  user.disabled = disabled
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mt-10">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("siteAdmin.accounts") }}</h2>
    <div class="ui-card px-4">
      <SettingsRow :label="t('siteAdmin.registration')" :label-id="`${id}-registration`">
        <template #description>{{ policyError ? failureMessage(policyError) : t("siteAdmin.registrationDescription") }}</template>
        <UiSwitch v-if="policy" :model-value="policy.registrationEnabled" :aria-labelledby="`${id}-registration`" name="public-registration" :disabled="!!pending" @update:model-value="setRegistration" />
      </SettingsRow>
    </div>
    <form class="mt-4 flex gap-2" role="search" @submit.prevent="search">
      <div class="relative min-w-0 flex-1">
        <Search :size="15" :stroke-width="1.75" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-text-faint" aria-hidden="true" />
        <input v-model="query" type="search" class="ui-input pl-8" name="account-search" :aria-label="t('siteAdmin.searchUsers')" :placeholder="t('siteAdmin.searchUsers')" maxlength="200" />
      </div>
      <UiButton type="submit" :loading="searching">{{ t("siteAdmin.search") }}</UiButton>
    </form>
    <p v-if="actionError" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ actionError }}</p>
    <template v-if="results">
      <ul v-if="results.users.length" class="ui-card m-0 mt-3 list-none p-0">
        <li v-for="user in results.users" :key="user.id" class="ui-card-row py-3" :data-account-id="user.id">
          <UserAvatar :name="user.name" :email="user.email" :size="32" class="text-[13px]" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-sm"><span class="truncate">{{ user.name }}</span><span v-if="user.disabled" class="ui-badge bg-ui-danger/10 text-ui-danger">{{ t("siteAdmin.disabled") }}</span></div>
            <div class="truncate text-[13px] text-ui-text-muted">{{ user.email }}</div>
          </div>
          <UiButton v-if="user.disabled" class="shrink-0" :loading="pending === user.id" :disabled="!!pending" @click="run(user.id, () => setDisabled(user, false))">{{ t("siteAdmin.enableUser") }}</UiButton>
          <UiButton v-else variant="danger" class="shrink-0" :disabled="!!pending" @click="disabling = user">{{ t("siteAdmin.disableUser") }}</UiButton>
        </li>
      </ul>
      <p v-else class="m-0 mt-3 text-sm text-ui-text-muted">{{ t("siteAdmin.noAccounts", { query: results.query }) }}</p>
      <p v-if="results.users.length >= resultLimit" class="m-0 mt-2 text-xs text-ui-text-muted">{{ t("siteAdmin.resultLimit", { count: resultLimit }) }}</p>
    </template>
  </section>
  <ConfirmDialog
    v-if="disabling"
    :title="t('siteAdmin.disableTitle', { name: disabling.name })"
    :description="t('siteAdmin.disableDescription')"
    :confirm-label="t('siteAdmin.disableUser')"
    :confirm="() => setDisabled(disabling!, true)"
    @close="disabling = undefined"
  />
</template>
