<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { KeepAwakeState } from "../../../../client/src/settings.ts"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const state = ref<KeepAwakeState | null>(null)
const loading = ref(true)
const saving = ref(false)
const requestError = ref<string | null>(null)
const busy = computed(() => loading.value || saving.value)

async function load() {
  loading.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.getKeepAwake()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function setEnabled(enabled: boolean) {
  saving.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.setKeepAwake(enabled)
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <SettingsRow :label="t('settings.keepAwake')" label-id="keep-awake-label" description-id="keep-awake-description">
    <template #description>{{ t("settings.keepAwakeDescription") }}</template>
    <span v-if="busy" role="status" class="text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : t("catalog.saving") }}</span>
    <button v-if="!state && requestError" type="button" class="ui-button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</button>
    <button
      type="button"
      role="switch"
      aria-labelledby="keep-awake-label"
      aria-describedby="keep-awake-description"
      :aria-checked="state?.enabled ?? false"
      :disabled="busy || !state"
      class="ui-switch ml-2 disabled:cursor-default"
      @click="setEnabled(!state?.enabled)"
    >
      <span class="ui-switch-thumb" :class="state?.enabled && 'translate-x-4'" />
    </button>
  </SettingsRow>
  <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
</template>
