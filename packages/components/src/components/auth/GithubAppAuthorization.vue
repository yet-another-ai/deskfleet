<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountUser, GithubAppSettings } from "@deskfleet/client/central"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { failureMessage } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UserAvatar from "../common/UserAvatar.vue"
import AuthLayout from "./AuthLayout.vue"

const props = defineProps<{ api: HttpCentralClient; user: AccountUser; signOut(): Promise<void> }>()
const { t } = useI18n()
const params = new URLSearchParams(location.search)
const expectedUserId = params.get("user")
const result = params.get("githubAppResult")
const matches = computed(() => expectedUserId === props.user.id)
const pending = ref(false)
const actionError = ref<string | undefined>(result === "failed" ? t("githubSettings.authorizationFailed") : undefined)
const { state, isLoading, error, executeImmediate: reload } = useAsyncState(
  () => props.api.request<GithubAppSettings>("GET", "/api/integrations/github"), undefined,
  { immediate: matches.value },
)
const complete = computed(() => result === "authorized" && state.value?.authorized)
async function authorize(): Promise<void> {
  if (pending.value || !matches.value || !state.value?.configured) return
  pending.value = true
  actionError.value = undefined
  try {
    const { authorizationUrl } = await props.api.request<{ authorizationUrl: string }>("POST", "/api/integrations/github/authorization/start", { expectedUserId })
    location.assign(authorizationUrl)
  } catch (reason) { actionError.value = failureMessage(reason); pending.value = false }
}
async function differentAccount(): Promise<void> {
  pending.value = true
  try { await props.signOut() }
  catch (reason) { actionError.value = failureMessage(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <AuthLayout :title="t('githubSettings.authorizeTitle')" :description="t('githubSettings.authorizeDescription')">
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3 rounded-lg border border-ui-border bg-ui-sidebar px-3 py-2.5">
        <UserAvatar :name="user.name" :email="user.email" :size="32" class="text-[13px]" />
        <div class="min-w-0"><div class="truncate text-sm font-medium">{{ user.name }}</div><div class="truncate text-[13px] text-ui-text-muted">{{ user.email }}</div></div>
      </div>
      <p v-if="!expectedUserId" role="alert" class="m-0 text-sm text-ui-danger">{{ t("githubSettings.openFromSettings") }}</p>
      <p v-else-if="!matches" role="alert" class="m-0 text-sm text-ui-danger">{{ t("githubSettings.wrongAccount") }}</p>
      <p v-else-if="isLoading" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("settings.loading") }}</p>
      <p v-else-if="complete" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("githubSettings.authorizationComplete") }}</p>
      <p v-else-if="state?.configured === false" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("githubSettings.unavailable") }}</p>
      <p v-if="actionError || error" role="alert" class="m-0 text-sm text-ui-danger">{{ actionError || failureMessage(error) }}</p>
      <UiButton v-if="matches && state?.configured && !complete" variant="primary" :loading="pending" :disabled="pending || isLoading" @click="authorize">{{ t("githubSettings.authorize") }}</UiButton>
      <UiButton v-if="error" :disabled="isLoading" @click="reload()">{{ t("settings.retryLoad") }}</UiButton>
      <a v-if="complete" href="/#/settings/github" class="text-center text-sm text-ui-accent hover:underline">{{ t("githubSettings.returnToSettings") }}</a>
      <UiButton v-else-if="expectedUserId" variant="ghost" :disabled="pending" @click="differentAccount">{{ t("auth.differentAccount") }}</UiButton>
    </div>
  </AuthLayout>
</template>
