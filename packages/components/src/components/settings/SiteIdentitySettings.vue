<script setup lang="ts">
import { ref } from "vue"
import { useAsyncState } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import UiButton from "../common/UiButton.vue"
const props = defineProps<{ api: SiteAdministrationApi }>()
const { t } = useI18n()
const query = ref("")
const users = ref<Awaited<ReturnType<SiteAdministrationApi["users"]>>>([])
const busy = ref(false)
const actionError = ref("")
const { state, error, executeImmediate } = useAsyncState(() => props.api.registrationPolicy(), undefined)
async function run(action: () => Promise<void>) {
  busy.value = true; actionError.value = ""
  try { await action() } catch (reason) { actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
async function registration() { await run(async () => { await props.api.updateRegistration(!state.value?.registrationEnabled); await executeImmediate() }) }
async function search() { await run(async () => { users.value = await props.api.users(query.value) }) }
async function disable(id: string, disabled: boolean) { await run(async () => { await props.api.disableUser(id, disabled); users.value = await props.api.users(query.value) }) }
</script>
<template>
  <section class="mt-8 grid gap-4">
    <h2 class="ui-section-title">{{ t("siteAdmin.accounts") }}</h2>
    <p v-if="error || actionError" role="alert" class="m-0 text-sm text-ui-danger">{{ actionError || String(error) }}</p>
    <div v-if="state" class="ui-card flex items-center justify-between gap-4 p-4"><p class="m-0 text-sm">{{ t(state.registrationEnabled ? "siteAdmin.registrationOpen" : "auth.registrationClosed") }}</p><UiButton :disabled="busy" @click="registration">{{ t(state.registrationEnabled ? "siteAdmin.closeRegistration" : "siteAdmin.openRegistration") }}</UiButton></div>
    <form class="flex gap-2" @submit.prevent="search"><input v-model="query" class="ui-input min-w-0 flex-1" :aria-label="t('siteAdmin.searchUsers')" :placeholder="t('siteAdmin.searchUsers')" maxlength="200"><UiButton type="submit" :loading="busy">{{ t("siteAdmin.search") }}</UiButton></form>
    <div v-for="user in users" :key="user.id" class="ui-card flex items-center justify-between gap-4 p-4"><div class="min-w-0 text-sm"><p class="m-0 truncate font-medium">{{ user.name }}</p><p class="m-0 mt-1 truncate text-ui-text-muted">{{ user.email }}</p></div><UiButton :variant="user.disabled ? 'default' : 'danger'" :disabled="busy" @click="disable(user.id, !user.disabled)">{{ t(user.disabled ? "siteAdmin.enableUser" : "siteAdmin.disableUser") }}</UiButton></div>
    <p class="m-0 text-xs text-ui-text-muted">{{ t("siteAdmin.disableHint") }}</p>
    <a href="/auth/account" class="text-sm">{{ t("auth.confirmIdentity") }}</a>
  </section>
</template>
