<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi, TurnSettings } from "@deskfleet/client/central"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{ api: Pick<SiteAdministrationApi, "turnSettings" | "updateTurnSettings"> }>()
const { t } = useI18n()
const id = useId()
const form = ref<TurnSettings>()
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const { state: current, isLoading: loading, error: loadError, executeImmediate: load } = useAsyncState(
  async () => {
    const settings = await props.api.turnSettings()
    form.value = { urls: [...settings.urls] }
    return settings
  },
  undefined,
)
const urls = computed(() => form.value?.urls.map(url => url.trim()) ?? [])
const changed = computed(() => !!form.value && (
  urls.value.length !== current.value?.urls.length
  || urls.value.some((url, index) => url !== current.value?.urls[index])
))
const valid = computed(() => urls.value.every(url => url.length > 0))
const { isLoading: saving, isReady: saved, error: saveError, executeImmediate: save } = useAsyncState(
  async () => {
    const settings = await props.api.updateTurnSettings({ urls: urls.value })
    current.value = settings
    form.value = { urls: [...settings.urls] }
  },
  undefined,
  { immediate: false },
)
function submit(): void {
  if (changed.value && valid.value && !saving.value) void save()
}
</script>

<template>
  <section class="mt-8" :aria-labelledby="`${id}-title`">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2">{{ t("siteAdmin.turnTitle") }}</h2>
    <p class="m-0 mb-4 text-[13px] text-ui-text-muted">{{ t("siteAdmin.turnDescription") }}</p>
    <p v-if="loading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    <div v-else-if="loadError">
      <p role="alert" class="text-sm text-ui-danger">{{ message(loadError) }}</p>
      <UiButton type="button" @click="load()">{{ t("welcome.retry") }}</UiButton>
    </div>
    <form v-else-if="form" class="flex flex-col gap-4" :aria-labelledby="`${id}-title`" @submit.prevent="submit">
      <div class="ui-card px-4">
        <div v-for="(_, index) in form.urls" :key="index" class="ui-setting flex items-center gap-3 py-3">
          <label :for="`${id}-url-${index}`" class="shrink-0 text-sm text-ui-text-muted">{{ index + 1 }}<span class="sr-only"> — {{ t("siteAdmin.turnUrl") }}</span></label>
          <input :id="`${id}-url-${index}`" v-model="form.urls[index]" class="ui-input min-w-0 flex-1 font-mono text-xs" :name="`turn-url-${index}`" :aria-label="t('siteAdmin.turnUrlLabel', { number: index + 1 })" placeholder="turn:turn.example.com:3478?transport=udp" required autocomplete="off" spellcheck="false" :disabled="saving" />
          <UiButton variant="ghost" size="icon" :aria-label="t('siteAdmin.turnRemove', { number: index + 1 })" :disabled="saving" @click="form.urls.splice(index, 1)"><Trash2 :size="15" aria-hidden="true" /></UiButton>
        </div>
        <p v-if="form.urls.length === 0" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("siteAdmin.turnEmpty") }}</p>
        <div class="py-3">
          <UiButton :disabled="saving" @click="form.urls.push('')"><Plus :size="14" aria-hidden="true" />{{ t("siteAdmin.turnAdd") }}</UiButton>
        </div>
      </div>
      <p v-if="saveError" role="alert" class="m-0 text-sm text-ui-danger">{{ message(saveError) }}</p>
      <p v-else-if="saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("siteAdmin.turnSaved") }}</p>
      <UiButton variant="primary" type="submit" class="self-start" :disabled="saving || !changed || !valid">{{ t(saving ? "catalog.saving" : "catalog.save") }}</UiButton>
    </form>
  </section>
</template>
