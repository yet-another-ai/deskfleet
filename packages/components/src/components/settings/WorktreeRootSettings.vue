<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { WorktreeRootState } from "../../../../client/src/settings.ts"
import SettingsRow from "./SettingsRow.vue"

const platformClient = usePlatformClient()

const { t } = useI18n()
const state = ref<WorktreeRootState | null>(null)
const loading = ref(true)
const choosing = ref(false)
const saving = ref(false)
const requestError = ref<string | null>(null)
const busy = computed(() => loading.value || choosing.value || saving.value)

async function load() {
  loading.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.getWorktreeRoot()
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}

async function save(root: string | null) {
  saving.value = true
  requestError.value = null
  try {
    state.value = await platformClient.settings.setWorktreeRoot(root)
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { saving.value = false }
}

async function choose() {
  choosing.value = true
  requestError.value = null
  try {
    const root = await platformClient.settings.chooseWorktreeRoot()
    if (root !== null) await save(root)
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error)
  } finally { choosing.value = false }
}

onMounted(load)
</script>

<template>
  <SettingsRow :label="t('settings.worktreeRoot')" label-id="worktree-root-label" description-id="worktree-root-description">
    <template #description>
      {{ t("settings.worktreeRootDescription") }}
      <div v-if="state" id="worktree-root-path" class="mt-1 break-all font-mono text-xs">{{ state.root ?? state.defaultRoot }}</div>
    </template>
    <div class="flex flex-col items-end gap-2">
      <span v-if="busy" role="status" class="text-[13px] text-ui-text-muted">{{ loading ? t("settings.loading") : saving ? t("catalog.saving") : t("settings.choosingFolder") }}</span>
      <UiButton v-if="!state && requestError" type="button" :disabled="busy" @click="load">{{ t("settings.retryLoad") }}</UiButton>
      <UiButton
        type="button"
        aria-describedby="worktree-root-label worktree-root-description"
        :disabled="busy || !state"
        @click="choose"
      >{{ t("settings.chooseWorktreeRoot") }}</UiButton>
      <UiButton v-if="state && state.root !== null" type="button" :disabled="busy" @click="save(null)">{{ t("settings.useDefaultWorktreeRoot") }}</UiButton>
    </div>
  </SettingsRow>
  <p v-if="requestError" role="alert" class="m-0 -mt-1 break-words pb-3 text-[13px] text-ui-danger">{{ requestError }}</p>
</template>
