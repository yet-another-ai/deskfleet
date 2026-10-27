<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi, SiteSettings } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const props = defineProps<{ api: SiteAdministrationApi }>()
const { t } = useI18n()
const id = useId()
const session = useAccountSession()!
const form = ref<SiteSettings>()
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const { state: current, isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(
  async () => {
    const settings = await props.api.siteSettings()
    form.value = { ...settings }
    session.site.value = settings
    return settings
  },
  undefined,
)
const changed = computed(() => !!form.value?.siteName.trim() && (
  form.value.siteName.trim() !== current.value?.siteName
  || form.value.announcement !== current.value?.announcement
  || form.value.allowTeamCreation !== current.value?.allowTeamCreation
))
const { isLoading: saving, isReady: saved, error: saveError, executeImmediate: save } = useAsyncState(
  async () => {
    const settings = await props.api.updateSiteSettings({ ...form.value!, siteName: form.value!.siteName.trim() })
    current.value = settings
    form.value = { ...settings }
    session.site.value = settings
  },
  undefined,
  { immediate: false },
)
function submit(): void {
  if (changed.value && !saving.value) void save()
}
</script>

<template>
  <header class="mb-8">
    <h1 class="ui-page-title">{{ t("siteAdmin.title") }}</h1>
    <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("siteAdmin.description") }}</p>
  </header>
  <p v-if="loading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
  <div v-else-if="loadError">
    <p role="alert" class="text-sm text-ui-danger">{{ message(loadError) }}</p>
    <UiButton type="button" @click="load()">{{ t("welcome.retry") }}</UiButton>
  </div>
  <form v-else-if="form" class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="ui-card px-4">
      <label class="ui-setting flex min-h-14 flex-col gap-2 py-3 text-sm lg:flex-row lg:items-center lg:justify-between lg:gap-6" :for="`${id}-name`">
        {{ t("siteAdmin.siteName") }}
        <input :id="`${id}-name`" v-model="form.siteName" class="ui-input w-full lg:w-64" name="site-name" required maxlength="200" autocomplete="off" :disabled="saving" />
      </label>
      <SettingsRow :label="t('siteAdmin.allowTeamCreation')" :label-id="`${id}-teams`">
        <template #description>{{ t("siteAdmin.allowTeamCreationDescription") }}</template>
        <UiSwitch v-model="form.allowTeamCreation" :aria-labelledby="`${id}-teams`" name="allow-team-creation" :disabled="saving" />
      </SettingsRow>
      <label class="flex flex-col gap-2 py-4 text-sm" :for="`${id}-announcement`">
        {{ t("siteAdmin.announcement") }}
        <textarea :id="`${id}-announcement`" v-model="form.announcement" class="ui-input min-h-28 resize-y" name="announcement" maxlength="10000" rows="4" :disabled="saving" />
        <span class="text-[13px] text-ui-text-muted">{{ t("siteAdmin.announcementDescription") }}</span>
      </label>
    </div>
    <p v-if="saveError" role="alert" class="m-0 text-sm text-ui-danger">{{ message(saveError) }}</p>
    <p v-else-if="saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("siteAdmin.saved") }}</p>
    <UiButton variant="primary" type="submit" class="self-start" :disabled="saving || !changed">{{ t(saving ? "catalog.saving" : "catalog.save") }}</UiButton>
  </form>
</template>
