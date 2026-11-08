<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { CloudflareTurnSettings, SiteAdministrationApi } from "@deskfleet/client/central"
import UiButton from "../common/UiButton.vue"
import UiField from "../common/UiField.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const props = defineProps<{ api: Pick<SiteAdministrationApi, "cloudflareTurnSettings" | "updateCloudflareTurnSettings"> }>()
const { t } = useI18n()
const id = useId()
const form = ref<CloudflareTurnSettings>()
const apiToken = ref("")
const analyticsToken = ref("")
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
function reset(settings: CloudflareTurnSettings): CloudflareTurnSettings {
  form.value = { ...settings }
  apiToken.value = ""
  analyticsToken.value = ""
  return settings
}
const { state: current, isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(
  async () => reset(await props.api.cloudflareTurnSettings()),
  undefined,
)
const accountId = computed(() => form.value?.accountId.trim() ?? "")
const keyId = computed(() => form.value?.keyId.trim() ?? "")
const changed = computed(() => !!form.value && (
  form.value.enabled !== current.value?.enabled
  || accountId.value !== current.value?.accountId
  || keyId.value !== current.value?.keyId
  || apiToken.value.trim().length > 0 || analyticsToken.value.trim().length > 0
))
const valid = computed(() => !form.value?.enabled || (
  !!accountId.value && !!keyId.value
  && (!!apiToken.value.trim() || !!current.value?.apiTokenConfigured)
  && (!!analyticsToken.value.trim() || !!current.value?.analyticsTokenConfigured)
))
const { isLoading: saving, isReady: saved, error: saveError, executeImmediate: save } = useAsyncState(
  async () => {
    current.value = reset(await props.api.updateCloudflareTurnSettings({
      enabled: form.value!.enabled, accountId: accountId.value, keyId: keyId.value,
      ...(apiToken.value.trim() ? { apiToken: apiToken.value.trim() } : {}),
      ...(analyticsToken.value.trim() ? { analyticsToken: analyticsToken.value.trim() } : {}),
    }))
  },
  undefined,
  { immediate: false },
)
function submit(): void {
  if (changed.value && valid.value && !saving.value) void save()
}
</script>

<template>
  <header class="mb-8">
    <h1 :id="`${id}-title`" class="ui-page-title">{{ t("siteAdmin.cloudflareTurnTitle") }}</h1>
    <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("siteAdmin.cloudflareTurnDescription") }}</p>
  </header>
  <section :aria-labelledby="`${id}-title`">
    <p v-if="loading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    <div v-else-if="loadError">
      <p role="alert" class="text-sm text-ui-danger">{{ message(loadError) }}</p>
      <UiButton @click="load()">{{ t("welcome.retry") }}</UiButton>
    </div>
    <form v-else-if="form" class="flex flex-col gap-4" :aria-labelledby="`${id}-title`" @submit.prevent="submit">
      <div class="ui-card">
        <SettingsRow :label="t('siteAdmin.cloudflareTurnEnabled')" :label-id="`${id}-enabled`">
          <UiSwitch v-model="form.enabled" :aria-labelledby="`${id}-enabled`" name="cloudflare-turn-enabled" :disabled="saving" />
        </SettingsRow>
        <template v-if="form.enabled || current?.accountId || current?.keyId">
          <div class="ui-setting px-4 py-3">
            <UiField v-model="form.accountId" :label="t('siteAdmin.cloudflareTurnAccountId')" name="cloudflare-turn-account-id" autocomplete="off" spellcheck="false" :required="form.enabled" :disabled="saving" />
          </div>
          <div class="ui-setting px-4 py-3">
            <UiField v-model="form.keyId" :label="t('siteAdmin.cloudflareTurnKeyId')" name="cloudflare-turn-key-id" autocomplete="off" spellcheck="false" :required="form.enabled" :disabled="saving" />
          </div>
          <div class="ui-setting px-4 py-3">
            <UiField v-model="apiToken" :label="t('siteAdmin.cloudflareTurnApiToken')" name="cloudflare-turn-api-token" type="password" autocomplete="new-password" spellcheck="false" :placeholder="current?.apiTokenConfigured ? t('siteAdmin.cloudflareTurnTokenSaved') : undefined" :hint="t('siteAdmin.cloudflareTurnApiTokenHint')" :required="form.enabled && !current?.apiTokenConfigured" :disabled="saving" />
          </div>
          <div class="ui-setting px-4 py-3">
            <UiField v-model="analyticsToken" :label="t('siteAdmin.cloudflareTurnAnalyticsToken')" name="cloudflare-turn-analytics-token" type="password" autocomplete="new-password" spellcheck="false" :placeholder="current?.analyticsTokenConfigured ? t('siteAdmin.cloudflareTurnTokenSaved') : undefined" :hint="t('siteAdmin.cloudflareTurnAnalyticsTokenHint')" :required="form.enabled && !current?.analyticsTokenConfigured" :disabled="saving" />
          </div>
          <p v-if="current?.apiTokenConfigured || current?.analyticsTokenConfigured" class="m-0 px-4 pb-3 text-[13px] text-ui-text-muted">{{ t('siteAdmin.cloudflareTurnKeepTokens') }}</p>
        </template>
      </div>
      <p v-if="saveError" role="alert" class="m-0 text-sm text-ui-danger">{{ message(saveError) }}</p>
      <p v-else-if="saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("siteAdmin.cloudflareTurnSaved") }}</p>
      <UiButton variant="primary" type="submit" class="self-start" :disabled="saving || !changed || !valid">{{ t(saving ? "catalog.saving" : "catalog.save") }}</UiButton>
    </form>
  </section>
</template>
