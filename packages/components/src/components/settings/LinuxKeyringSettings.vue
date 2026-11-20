<script setup lang="ts">
import { RotateCcw } from "@lucide/vue"
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { LinuxKeyringState } from "../../../../client/src/settings.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const platformClient = usePlatformClient()
const visible = computed(() => platformClient.platform === "linux" && typeof platformClient.settings.getLinuxKeyring === "function")

const { t } = useI18n()
const state = ref<LinuxKeyringState | null>(null)
const loading = ref(true)
const saving = ref(false)
const restarting = ref(false)
const requestError = ref<string | null>(null)
const busy = computed(() => loading.value || saving.value || restarting.value)

async function load() {
  if (!visible.value || !platformClient.settings.getLinuxKeyring) return
  loading.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.getLinuxKeyring()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function setUseSystemKeyring(useSystemKeyring: boolean) {
  if (!platformClient.settings.setLinuxKeyring) return
  saving.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.setLinuxKeyring(useSystemKeyring)
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

async function restartApplication() {
  if (!platformClient.application?.restart) return
  restarting.value = true
  requestError.value = null
  try {
    await platformClient.application.restart()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { restarting.value = false }
}

onMounted(load)
</script>

<template>
  <template v-if="visible">
    <SettingsRow :label="t('settings.linuxKeyring')" label-id="linux-keyring-label" description-id="linux-keyring-description">
      <template #description>{{ t("settings.linuxKeyringDescription") }}</template>
      <span v-if="loading || saving" role="status" class="text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : t("catalog.saving") }}</span>
      <span v-else-if="state?.overriddenExternally" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.linuxKeyringOverridden") }}</span>
      <span v-else-if="state?.restartRequired" role="status" class="text-[13px] text-ui-text-muted">{{ t("settings.linuxKeyringRestartRequired") }}</span>
      <UiButton v-if="!state && requestError" type="button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</UiButton>
      <UiButton v-else-if="!state?.overriddenExternally && state?.restartRequired && platformClient.application?.restart" type="button" :disabled="busy" @click="restartApplication">
        <RotateCcw :size="14" aria-hidden="true" />{{ t("common.restartDeskFleet") }}
      </UiButton>
      <UiSwitch
        aria-labelledby="linux-keyring-label"
        aria-describedby="linux-keyring-description"
        :model-value="state?.useSystemKeyring ?? true"
        :disabled="busy || !state || state.overriddenExternally"
        class="ml-2 disabled:cursor-default"
        @update:model-value="setUseSystemKeyring"
      />
    </SettingsRow>
    <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words px-4 pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
  </template>
</template>
