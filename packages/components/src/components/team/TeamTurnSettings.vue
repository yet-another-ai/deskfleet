<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi, TeamTurnSettings } from "@deskfleet/client/central"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import UiButton from "../common/UiButton.vue"
import UiField from "../common/UiField.vue"

/** A Team's own TURN REST API server. The shared secret is write-only. */
const props = defineProps<{ api: Pick<CentralApi, "teamTurnSettings" | "updateTeamTurnSettings">; teamId: string }>()
const emit = defineEmits<{ plans: [] }>()
const { t } = useI18n()
const id = useId()
const urlsForm = ref<string[]>([])
const secret = ref("")
const removing = ref(false)
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
function reset(settings: TeamTurnSettings): TeamTurnSettings {
  urlsForm.value = settings.urls.length ? [...settings.urls] : [""]
  secret.value = ""
  return settings
}
const { state: current, isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(
  async () => reset(await props.api.teamTurnSettings(props.teamId)),
  undefined,
)
const urls = computed(() => urlsForm.value.map(url => url.trim()))
const changed = computed(() => secret.value.length > 0
  || urls.value.length !== current.value?.urls.length
  || urls.value.some((url, index) => url !== current.value?.urls[index]))
const valid = computed(() => urls.value.length > 0 && urls.value.every(url => url.length > 0)
  && (secret.value.length > 0 || !!current.value?.secretConfigured))
const { isLoading: saving, isReady: saved, error: saveError, executeImmediate: save } = useAsyncState(
  async () => {
    current.value = reset(await props.api.updateTeamTurnSettings(props.teamId, {
      urls: urls.value,
      ...(secret.value ? { secret: secret.value } : {}),
    }))
  },
  undefined,
  { immediate: false },
)
function submit(): void {
  if (changed.value && valid.value && !saving.value) void save()
}
async function remove(): Promise<void> {
  current.value = reset(await props.api.updateTeamTurnSettings(props.teamId, { urls: [] }))
  saveError.value = undefined
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("team.turnTitle") }}</h2>
    <p class="m-0 mb-4 text-[13px] text-ui-text-muted">{{ t("team.turnDescription") }}</p>
    <p v-if="loading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    <div v-else-if="loadError">
      <p role="alert" class="text-sm text-ui-danger">{{ message(loadError) }}</p>
      <UiButton type="button" @click="load()">{{ t("welcome.retry") }}</UiButton>
    </div>
    <template v-else-if="current">
      <div v-if="current.availability !== 'available'" class="ui-card flex flex-col items-start gap-3 p-4" data-team-turn-unavailable>
        <p class="m-0 text-sm">{{ t(current.availability === "planRequired" ? "team.turnPlanRequired" : "team.turnDisabledBySite") }}</p>
        <p v-if="current.secretConfigured" class="m-0 text-[13px] text-ui-text-muted">{{ t("team.turnSavedUnused", { urls: current.urls.join(", ") }) }}</p>
        <div v-if="current.availability === 'planRequired' || current.secretConfigured" class="flex flex-wrap gap-2">
          <UiButton v-if="current.availability === 'planRequired'" variant="primary" @click="emit('plans')">{{ t("team.turnViewPlans") }}</UiButton>
          <UiButton v-if="current.secretConfigured" @click="removing = true">{{ t("team.turnRemoveServer") }}</UiButton>
        </div>
      </div>
      <form v-else class="flex flex-col gap-4" :aria-labelledby="`${id}-title`" @submit.prevent="submit">
        <div class="ui-card">
          <div v-for="(_, index) in urlsForm" :key="index" class="ui-setting flex items-center gap-3 px-4 py-3">
            <label :for="`${id}-url-${index}`" class="shrink-0 text-sm text-ui-text-muted">{{ index + 1 }}<span class="sr-only"> — {{ t("siteAdmin.turnUrl") }}</span></label>
            <input :id="`${id}-url-${index}`" v-model="urlsForm[index]" class="ui-input min-w-0 flex-1 font-mono text-xs" :name="`team-turn-url-${index}`" :aria-label="t('siteAdmin.turnUrlLabel', { number: index + 1 })" placeholder="turn:turn.example.com:3478?transport=udp" required autocomplete="off" spellcheck="false" :disabled="saving" />
            <UiButton variant="ghost" size="icon" :aria-label="t('siteAdmin.turnRemove', { number: index + 1 })" :disabled="saving || urlsForm.length === 1" @click="urlsForm.splice(index, 1)"><Trash2 :size="15" aria-hidden="true" /></UiButton>
          </div>
          <div class="ui-setting px-4 py-3">
            <UiButton :disabled="saving" @click="urlsForm.push('')"><Plus :size="14" aria-hidden="true" />{{ t("siteAdmin.turnAdd") }}</UiButton>
          </div>
          <div class="ui-setting px-4 py-3">
            <UiField v-model="secret" :label="t('team.turnSecret')" type="password" name="team-turn-secret" autocomplete="new-password" maxlength="1024" spellcheck="false" :required="!current.secretConfigured" :placeholder="current.secretConfigured ? t('team.turnSecretSaved') : undefined" :hint="t(current.secretConfigured ? 'team.turnSecretKeepHint' : 'team.turnSecretHint')" :disabled="saving" />
          </div>
        </div>
        <p v-if="saveError" role="alert" class="m-0 text-sm text-ui-danger">{{ message(saveError) }}</p>
        <p v-else-if="saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("team.turnSaved") }}</p>
        <div class="flex flex-wrap gap-2">
          <UiButton variant="primary" type="submit" :disabled="saving || !changed || !valid">{{ t(saving ? "catalog.saving" : "catalog.save") }}</UiButton>
          <UiButton v-if="current.secretConfigured" :disabled="saving" @click="removing = true">{{ t("team.turnRemoveServer") }}</UiButton>
        </div>
      </form>
    </template>
    <ConfirmDialog
      v-if="removing"
      :title="t('team.turnRemoveTitle')"
      :description="t('team.turnRemoveDescription')"
      :confirm-label="t('team.turnRemoveServer')"
      :confirm="remove"
      @close="removing = false"
    />
  </section>
</template>
