<script setup lang="ts">
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { BillingPlan, PlanQuota } from "@deskfleet/client/billing"
import type { AdminPlanQuota, SiteAdministrationApi } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const props = defineProps<{
  api: Pick<SiteAdministrationApi, "planQuotas" | "updatePlanQuota">
  confirmed: RecentAuthentication["confirmed"]
}>()
const { t } = useI18n()
const id = useId()
const fields = ["maxActiveSessions", "maxTurnsPerSession", "maxMembers", "turnBytes", "superAgentTokens"] as const
type Field = typeof fields[number]
interface Draft {
  plan: BillingPlan
  limits: PlanQuota
  inputs: Record<Field, string>
  teamTurnServers: boolean
  saved?: boolean
  error?: string
}
function draft({ plan, ...limits }: AdminPlanQuota): Draft {
  const inputs = Object.fromEntries(fields.map(key => [key, String(limits[key] ?? "")])) as Record<Field, string>
  return { plan, limits, inputs, teamTurnServers: limits.teamTurnServers }
}
const { state: plans, isLoading, error, executeImmediate: load } = useAsyncState(
  async () => (await props.api.planQuotas()).map(draft), [] as Draft[], { shallow: false },
)
const selected = ref<BillingPlan>("free")
const current = computed(() => plans.value.find(row => row.plan === selected.value))
const limits = computed<PlanQuota | undefined>(() => {
  const row = current.value
  if (!row) return
  const result = { ...row.limits, teamTurnServers: row.teamTurnServers }
  for (const key of fields) {
    const input = row.inputs[key]
    if (input && (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input)))) return
    result[key] = input === "" ? null : Number(input)
  }
  return result
})
const changed = computed(() => {
  const next = limits.value, previous = current.value?.limits
  return next && previous && (next.teamTurnServers !== previous.teamTurnServers || fields.some(key => next[key] !== previous[key]))
})
const saving = ref(false)
async function save(): Promise<void> {
  const row = current.value, next = limits.value
  if (!row || row.plan === "selfHosted" || !next || !changed.value || saving.value) return
  const plan = row.plan
  saving.value = true
  row.error = undefined
  row.saved = false
  try {
    const saved = await props.confirmed(() => props.api.updatePlanQuota(plan, next))
    Object.assign(row, draft(saved), { saved: true })
  } catch (reason) {
    row.error = failureMessage(reason)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <header class="mb-8">
    <h1 class="ui-page-title">{{ t("planQuotas.title") }}</h1>
    <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("planQuotas.description") }}</p>
  </header>
  <p v-if="isLoading" role="status" class="text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
  <div v-else-if="error">
    <p role="alert" class="text-sm text-ui-danger">{{ failureMessage(error) }}</p>
    <UiButton @click="load()">{{ t("welcome.retry") }}</UiButton>
  </div>
  <form v-else-if="current" class="flex flex-col gap-4" @submit.prevent="save">
    <label class="flex flex-col items-start gap-1 text-sm">{{ t("planQuotas.plan") }}
      <select v-model="selected" class="ui-input sm:max-w-60" name="plan" :disabled="saving">
        <option v-for="row in plans" :key="row.plan" :value="row.plan">{{ t(`billing.plan.${row.plan}`) }}</option>
      </select>
    </label>
    <p class="m-0 text-[13px] text-ui-text-muted">{{ t(selected === "selfHosted" ? "planQuotas.selfHosted" : "planQuotas.hint") }}</p>
    <div class="ui-card">
      <SettingsRow v-for="field in fields" :key="field" :label="t(`planQuotas.${field}`)" :label-id="`${id}-${field}`">
        <input v-model="current.inputs[field]" class="ui-input w-44 text-end tabular-nums" type="text" inputmode="numeric" pattern="[0-9]*" :name="field" :aria-labelledby="`${id}-${field}`" :placeholder="t('team.unlimited')" :disabled="selected === 'selfHosted' || saving" />
      </SettingsRow>
      <SettingsRow :label="t('planQuotas.teamTurnServers')" :label-id="`${id}-team-turn`">
        <UiSwitch v-model="current.teamTurnServers" :aria-labelledby="`${id}-team-turn`" :disabled="selected === 'selfHosted' || saving" />
      </SettingsRow>
    </div>
    <p v-if="!limits" role="alert" class="m-0 text-sm text-ui-danger">{{ t("planQuotas.invalid") }}</p>
    <p v-else-if="current.error" role="alert" class="m-0 text-sm text-ui-danger">{{ current.error }}</p>
    <p v-else-if="current.saved && !changed" role="status" class="m-0 text-sm text-ui-text-muted">{{ t("planQuotas.saved") }}</p>
    <UiButton v-if="selected !== 'selfHosted'" type="submit" variant="primary" class="self-start" :disabled="!changed || saving">{{ t(saving ? "catalog.saving" : "catalog.save") }}</UiButton>
  </form>
</template>
