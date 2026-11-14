<script setup lang="ts">
import { ChevronDown, RotateCcw } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { WorktreePreferences } from "../../../../client/src/settings.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import UiNumberField from "../common/UiNumberField.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"
import WorktreeRootSettings from "./WorktreeRootSettings.vue"

const client = usePlatformClient()
const { t } = useI18n()
const advanced = ref(false)
const { state, isLoading, error, executeImmediate } = useAsyncState(
  async (preferences?: WorktreePreferences): Promise<WorktreePreferences | null> => preferences
    ? client.settings.setWorktreePreferences(preferences)
    : client.settings.getWorktreePreferences(),
  null,
  { resetOnExecute: false, immediate: client.platform !== "web" },
)
const busy = computed(() => isLoading.value || !state.value)
const requestError = computed(() => error.value instanceof Error ? error.value.message : error.value ? String(error.value) : null)
const namingOptions = computed(() => [
  { value: "semantic", label: t("worktreeSettings.semantic") },
  { value: "session", label: t("worktreeSettings.sessionBranch") },
])
const protectionOptions = computed(() => [
  { value: "uncommitted", label: t("worktreeSettings.uncommitted") },
  { value: "all", label: t("worktreeSettings.allFiles") },
  { value: "none", label: t("worktreeSettings.noProtection") },
])
const cleanupOptions = [
  { key: "archived", description: "archivedDescription" },
  { key: "merged", description: "mergedDescription" },
  { key: "inactive", description: "inactiveDescription", days: "inactiveDays" },
  { key: "settled", description: "settledDescription", days: "settledDays", advanced: true },
  { key: "unchanged", description: "unchangedDescription", advanced: true },
] as const

function saveBranchNaming(value: string): void {
  if (busy.value || !state.value || value !== "semantic" && value !== "session") return
  void executeImmediate({ ...state.value, branchNaming: value, cleanup: { ...state.value.cleanup } })
}

function saveCleanup<K extends keyof WorktreePreferences["cleanup"]>(key: K, value: WorktreePreferences["cleanup"][K]): void {
  if (busy.value || !state.value) return
  // Pass plain data across Electron's contextBridge, including the nested preferences.
  void executeImmediate({ ...state.value, cleanup: { ...state.value.cleanup, [key]: value } })
}

function saveDays(key: "inactiveDays" | "settledDays", value: number): void {
  if (Number.isInteger(value) && value >= (key === "inactiveDays" ? 1 : 0) && value <= 3650) saveCleanup(key, value)
}

function saveProtection(value: string): void {
  if (value === "uncommitted" || value === "all" || value === "none") saveCleanup("keepLocalChanges", value)
}
</script>

<template>
  <h1 class="ui-page-title mb-2">{{ t("worktreeSettings.title") }}</h1>
  <p class="mb-6 mt-0 text-[13px] leading-relaxed text-ui-text-muted">{{ t(client.platform === "web" ? "worktreeSettings.desktopOnly" : "worktreeSettings.scope") }}</p>
  <template v-if="client.platform !== 'web'">
    <section aria-labelledby="worktree-branches-heading" class="mb-8">
      <h2 id="worktree-branches-heading" class="ui-section-title mb-2">{{ t("worktreeSettings.branches") }}</h2>
      <div class="ui-card">
        <SettingsRow :label="t('worktreeSettings.branchNaming')" label-id="worktree-branch-label" description-id="worktree-branch-description">
          <template #description>
            <p class="m-0">{{ t("worktreeSettings.branchDescription") }}</p>
            <p class="mb-0 mt-1.5">{{ t(state?.branchNaming === "session" ? "worktreeSettings.sessionDescription" : "worktreeSettings.semanticDescription") }}</p>
          </template>
          <UiButton v-if="state?.branchNaming !== 'semantic' && state" variant="ghost" size="sm" :disabled="busy" :aria-label="t('worktreeSettings.resetNaming')" @click="saveBranchNaming('semantic')">
            <RotateCcw :size="14" aria-hidden="true" />
          </UiButton>
          <UiSelect :model-value="state?.branchNaming ?? 'semantic'" :options="namingOptions" :disabled="busy" aria-labelledby="worktree-branch-label" aria-describedby="worktree-branch-description" class="min-w-44" @update:model-value="saveBranchNaming" />
        </SettingsRow>
      </div>
    </section>

    <section aria-labelledby="worktree-cleanup-heading" class="mb-8">
      <h2 id="worktree-cleanup-heading" class="ui-section-title mb-2">{{ t("worktreeSettings.cleanup") }}</h2>
      <div class="ui-card overflow-hidden">
        <template v-for="option in cleanupOptions" :key="option.key">
          <button v-if="option.key === 'settled'" type="button" class="ui-setting flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-[13px] text-ui-text-muted hover:bg-ui-hover" :aria-expanded="advanced" aria-controls="worktree-settled-row worktree-unchanged-row worktree-protection-row" @click="advanced = !advanced">
            <ChevronDown :size="15" :class="advanced ? '' : '-rotate-90'" aria-hidden="true" />
            {{ t("worktreeSettings.advanced") }}
          </button>
          <SettingsRow v-if="!('advanced' in option) || advanced" :id="`worktree-${option.key}-row`" :label="t(`worktreeSettings.${option.key}`)" :label-id="`worktree-${option.key}-label`" :description-id="`worktree-${option.key}-description`">
            <template #description>{{ t(`worktreeSettings.${option.description}`) }}</template>
            <UiNumberField v-if="'days' in option" :model-value="state?.cleanup[option.days] ?? (option.days === 'inactiveDays' ? 5 : 6)" :min="option.days === 'inactiveDays' ? 1 : 0" :max="3650" :unit="t('worktreeSettings.days')" :disabled="busy || !state?.cleanup[option.key]" :aria-labelledby="`worktree-${option.key}-label`" :aria-describedby="`worktree-${option.key}-description`" @update:model-value="saveDays(option.days, $event)" />
            <UiSwitch :model-value="state?.cleanup[option.key] ?? false" :disabled="busy" :aria-labelledby="`worktree-${option.key}-label`" :aria-describedby="`worktree-${option.key}-description`" class="sm:ml-3" @update:model-value="saveCleanup(option.key, $event)" />
          </SettingsRow>
        </template>
        <SettingsRow v-if="advanced" id="worktree-protection-row" :label="t('worktreeSettings.keepLocalChanges')" label-id="worktree-protection-label" description-id="worktree-protection-description">
          <template #description>{{ t(`worktreeSettings.protectionDescription.${state?.cleanup.keepLocalChanges ?? 'uncommitted'}`) }}</template>
          <UiSelect :model-value="state?.cleanup.keepLocalChanges ?? 'uncommitted'" :options="protectionOptions" :disabled="busy" aria-labelledby="worktree-protection-label" aria-describedby="worktree-protection-description" class="min-w-44" @update:model-value="saveProtection" />
        </SettingsRow>
      </div>
      <p class="mb-0 mt-2 text-[12px] leading-relaxed text-ui-text-muted">{{ t("worktreeSettings.cleanupNote") }}</p>
    </section>

    <p v-if="isLoading" role="status" class="my-3 text-[13px] text-ui-text-muted">{{ state ? t("catalog.saving") : t("settings.loading") }}</p>
    <p v-if="requestError" role="alert" class="my-3 break-words text-[13px] text-ui-danger">{{ requestError }}</p>
    <UiButton v-if="!state && requestError" :disabled="isLoading" class="mb-5" @click="executeImmediate()">{{ t("settings.retryLoad") }}</UiButton>

    <section aria-labelledby="worktree-storage-heading">
      <h2 id="worktree-storage-heading" class="ui-section-title mb-2">{{ t("worktreeSettings.storage") }}</h2>
      <div class="ui-card"><WorktreeRootSettings /></div>
    </section>
  </template>
</template>
