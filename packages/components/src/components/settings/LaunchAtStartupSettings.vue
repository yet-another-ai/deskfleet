<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LaunchAtStartupState } from "../../../../client/src/settings.ts"
import SettingsRow from "./SettingsRow.vue"

const platformClient = usePlatformClient()

const { t } = useI18n()
const state = ref<LaunchAtStartupState | null>(null)
const loading = ref(true)
const saving = ref(false)
const requestError = ref<string | null>(null)
const busy = computed(() => loading.value || saving.value)

async function load() {
  loading.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.getLaunchAtStartup()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function setEnabled(enabled: boolean) {
  saving.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.setLaunchAtStartup(enabled)
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <SettingsRow :label="t('settings.launchAtStartup')" label-id="launch-at-startup-label" description-id="launch-at-startup-description">
    <template #description>{{ state?.available === false ? t("settings.launchAtStartupUnavailable") : t("settings.launchAtStartupDescription") }}</template>
    <span v-if="busy" role="status" class="text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : t("catalog.saving") }}</span>
    <UiButton v-if="!state && requestError" type="button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</UiButton>
    <UiSwitch
      aria-labelledby="launch-at-startup-label"
      aria-describedby="launch-at-startup-description"
      :model-value="state?.enabled ?? false"
      :disabled="busy || !state?.available"
      class="ml-2 disabled:cursor-default"
      @update:model-value="setEnabled"
     />
  </SettingsRow>
  <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
</template>
