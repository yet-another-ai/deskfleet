<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{
  api: Pick<SiteAdministrationApi, "creditRates" | "updateCreditRates">
  confirmed: RecentAuthentication["confirmed"]
}>()
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const
const { t } = useI18n()
const heading = useId()
const { state: form, isLoading, error, executeImmediate: load } = useAsyncState(async () => {
  const rates = await props.api.creditRates()
  return { rates, draft: { ...rates } }
}, undefined, { shallow: false })
const next = computed(() => {
  if (!form.value) return
  const normalized = { ...form.value.draft }
  for (const field of fields) {
    const value = normalized[field].trim()
    if (!/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value)) return
    const [whole = "", fraction = ""] = value.split(".")
    const integer = whole.replace(/^0+/, "") || "0"
    if (integer.length > 12) return
    const decimal = fraction.replace(/0+$/, "")
    normalized[field] = integer + (decimal ? "." + decimal : "")
  }
  return normalized
})
const changed = computed(() => {
  const values = next.value
  return values && fields.some(field => values[field] !== form.value?.rates[field])
})
const saving = ref(false)
const saved = ref(false)
const saveError = ref<string>()
async function save(): Promise<void> {
  const values = next.value
  if (!values || !changed.value || saving.value) return
  saving.value = true
  saved.value = false
  saveError.value = undefined
  try {
    const result = await props.confirmed(() => props.api.updateCreditRates(values))
    form.value = { rates: result, draft: { ...result } }
    saved.value = true
  } catch (reason) {
    saveError.value = failureMessage(reason)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="mt-8" :aria-labelledby="heading">
    <h2 :id="heading" class="m-0 text-base font-semibold">{{ t("creditRates.title") }}</h2>
    <p class="m-0 mt-1 mb-4 text-[13px] text-ui-text-muted">{{ t("creditRates.description") }}</p>
    <p v-if="isLoading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
    <div v-else-if="error">
      <p role="alert" class="text-sm text-ui-danger">{{ failureMessage(error) }}</p>
      <UiButton @click="load()">{{ t("welcome.retry") }}</UiButton>
    </div>
    <form v-else-if="form" :aria-labelledby="heading" class="flex flex-col gap-4" @submit.prevent="save">
      <div class="ui-card grid gap-4 p-4 sm:grid-cols-2">
        <label v-for="field in fields" :key="field" class="flex min-w-0 flex-col gap-1 text-sm">
          {{ t(`creditRates.${field}`) }}
          <input v-model="form.draft[field]" class="ui-input tabular-nums" type="text" inputmode="decimal" :name="field" :disabled="saving" />
        </label>
      </div>
      <p v-if="!next" role="alert" class="m-0 text-sm text-ui-danger">{{ t("creditRates.invalid") }}</p>
      <p v-else-if="saveError" role="alert" class="m-0 text-sm text-ui-danger">{{ saveError }}</p>
      <p v-else-if="saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("creditRates.saved") }}</p>
      <UiButton type="submit" variant="primary" class="self-start" :disabled="!changed || saving">{{ t(saving ? "catalog.saving" : "creditRates.save") }}</UiButton>
    </form>
  </section>
</template>
