<script setup lang="ts">
import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { GithubAppSettings } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const account = useAccountSession()
const pending = ref(false)
const actionError = ref<string>()
const waiting = ref(false)
const { state, isLoading, error, executeImmediate: reload } = useAsyncState(
  () => account!.central.githubSettings(), undefined as GithubAppSettings | undefined,
  { immediate: !!account, resetOnExecute: false },
)
const busy = computed(() => isLoading.value || pending.value)
const message = computed(() => actionError.value ?? (error.value instanceof Error ? error.value.message : error.value ? String(error.value) : undefined))
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value || !state.value?.configured) return
  pending.value = true
  actionError.value = undefined
  try { await action() }
  catch (reason) { actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
function authorize(): void {
  void run(async () => { await account!.central.authorizeGithubApp(); waiting.value = true })
}
function setEnabled(enabled: boolean): void {
  if (!state.value?.authorized) return
  void run(async () => { state.value = await account!.central.setGithubActAsYou(enabled) })
}
useEventListener(window, "focus", () => {
  if (account && !busy.value) void reload().then(value => { if (value?.authorized) waiting.value = false })
})
</script>

<template>
  <h1 class="ui-page-title mb-2">{{ t("githubSettings.title") }}</h1>
  <p class="m-0 mb-6 text-sm text-ui-text-muted">{{ t("githubSettings.description") }}</p>
  <p v-if="!account || state?.configured === false" role="status" class="m-0 mb-4 text-sm text-ui-text-muted">{{ t("githubSettings.unavailable") }}</p>
  <section :aria-label="t('githubSettings.title')" class="ui-card px-4">
    <SettingsRow :label="t('githubSettings.repositories')">
      <template #description>{{ t("githubSettings.manageDescription") }}</template>
      <UiButton :disabled="busy || !state?.manageUrl" @click="run(() => account!.central.manageGithub())">{{ t("githubSettings.manage") }}</UiButton>
    </SettingsRow>
    <SettingsRow :label="t('githubSettings.actAsYou')" label-id="github-act-as-you-label" description-id="github-act-as-you-description">
      <template #description>
        {{ t("githubSettings.actAsYouDescription") }}
        <span v-if="state?.authorized && state.login" class="mt-1 block">{{ t("githubSettings.authorizedAs", { login: state.login }) }}</span>
      </template>
      <UiButton :disabled="busy || !state?.configured" @click="authorize">{{ t(state?.authorized ? 'githubSettings.reauthorize' : 'githubSettings.authorize') }}</UiButton>
      <UiSwitch :model-value="state?.actAsYou ?? false" :disabled="busy || !state?.configured || !state.authorized" aria-labelledby="github-act-as-you-label" aria-describedby="github-act-as-you-description" @update:model-value="setEnabled" />
    </SettingsRow>
  </section>
  <p v-if="busy" role="status" class="m-0 mt-3 text-sm text-ui-text-muted">{{ t(isLoading ? 'settings.loading' : 'catalog.saving') }}</p>
  <p v-else-if="waiting" role="status" class="m-0 mt-3 text-sm text-ui-text-muted">{{ t("githubSettings.waiting") }}</p>
  <p v-if="message" role="alert" class="m-0 mt-3 text-sm text-ui-danger">{{ message }}</p>
  <UiButton v-if="error" class="mt-3" :disabled="busy" @click="reload()">{{ t("settings.retryLoad") }}</UiButton>
</template>
