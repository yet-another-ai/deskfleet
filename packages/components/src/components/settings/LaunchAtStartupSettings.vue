<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LaunchAtStartupState } from "../../../../client/src/settings.ts"
import SettingsRow from "./SettingsRow.vue"

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
    <button v-if="!state && requestError" type="button" class="catalog-button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</button>
    <button
      type="button"
      role="switch"
      aria-labelledby="launch-at-startup-label"
      aria-describedby="launch-at-startup-description"
      :aria-checked="state?.enabled ?? false"
      :disabled="busy || !state?.available"
      class="relative ml-2 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-default disabled:opacity-50"
      :class="state?.enabled ? 'bg-ui-accent' : 'bg-ui-active'"
      @click="setEnabled(!state?.enabled)"
    >
      <span class="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform" :class="state?.enabled && 'translate-x-4'" />
    </button>
  </SettingsRow>
  <p v-if="requestError" role="alert" class="m-0 mt-1 break-words text-[13px] text-ui-danger">{{ requestError }}</p>
</template>
