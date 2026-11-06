<script setup lang="ts">
import { Search } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { AdminTeamBilling } from "@deskfleet/client/billing"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import UiButton from "../common/UiButton.vue"

/** Enterprise is a manual grant layered over billing; it never pauses or cancels a Stripe subscription. */
const props = defineProps<{ api: SiteAdministrationApi; confirmed: RecentAuthentication["confirmed"] }>()
const { t, te, locale } = useI18n()
const id = useId()
const filter = ref("")
const changing = ref<AdminTeamBilling>()
const { state: teams, isLoading, error, executeImmediate: load } = useAsyncState(() => props.api.billingTeams(), [])
const visible = computed(() => {
  const needle = filter.value.trim().toLocaleLowerCase()
  return needle ? teams.value.filter(team => [team.name, team.owner.name, team.owner.email].some(value => value.toLocaleLowerCase().includes(needle))) : teams.value
})
const ownerAccount = (team: AdminTeamBilling) => t("billing.teamOwnerAccount", { name: team.owner.name, email: team.owner.email })
const date = (value: string) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium" }).format(new Date(value))
const plan = (value: string) => t(`billing.plan.${value}`)
/** A subscription still billing or paying for coverage, which an Enterprise grant leaves running. */
const billing = (team: AdminTeamBilling) => {
  const value = team.billing.subscription
  return value && !["canceled", "incomplete_expired"].includes(value.status) ? value : undefined
}
function subscriptionSummary(team: AdminTeamBilling): string {
  const value = billing(team)
  if (!value) return t("billing.noSubscription")
  // Stripe can add statuses; an unknown one is shown as reported.
  const status = te(`billing.status.${value.status}`) ? t(`billing.status.${value.status}`) : value.status
  const parts = [t("billing.subscriptionPlan", { plan: plan(value.plan) }), status]
  if (value.paidThrough) parts.push(t(value.cancelAtPeriodEnd ? "billing.ends" : "billing.renews", { date: date(value.paidThrough) }))
  return parts.join(" · ")
}
const grantPlan = ref<"free" | "go" | "pro" | "enterprise" | "none">("enterprise")
const expiry = ref("")
const reason = ref("")
function openGrant(team: AdminTeamBilling): void {
  changing.value = team
  grantPlan.value = team.billing.manualGrant?.plan ?? "enterprise"
  const existingExpiry = team.billing.manualGrant?.expiresAt
  expiry.value = existingExpiry ? new Date(new Date(existingExpiry).getTime() - new Date(existingExpiry).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ""
  reason.value = ""
}
async function save(team: AdminTeamBilling): Promise<void> {
  if (!reason.value.trim()) throw new Error(t("billing.grantReasonRequired"))
  const expiresAt = expiry.value ? new Date(expiry.value).getTime() : null
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error(t("billing.grantExpiryInvalid"))
  await props.confirmed(() => props.api.setManualGrant(team.id, grantPlan.value === "none" ? null : grantPlan.value, grantPlan.value === "none" ? null : expiresAt, reason.value.trim()))
  await load()
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mt-10">
    <h2 :id="`${id}-title`" class="ui-section-title mb-1">{{ t("billing.enterpriseTeams") }}</h2>
    <p class="m-0 mb-3 text-[13px] text-ui-text-muted">{{ t("billing.manualGrantHint") }}</p>
    <div class="relative mb-3">
      <Search :size="15" :stroke-width="1.75" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-text-faint" aria-hidden="true" />
      <input v-model="filter" type="search" class="ui-input pl-8" name="team-filter" :aria-label="t('billing.filterTeams')" :placeholder="t('billing.filterTeams')" maxlength="200" />
    </div>
    <p v-if="isLoading && !teams.length" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
    <div v-else-if="error" class="flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
      <UiButton @click="load()">{{ t("auth.retry") }}</UiButton>
    </div>
    <ul v-else-if="visible.length" class="ui-card m-0 list-none p-0">
      <li v-for="team in visible" :key="team.id" class="ui-card-row py-3" :data-enterprise-team="team.id">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-sm"><span class="truncate">{{ team.name }}</span><span class="ui-badge shrink-0" :class="team.billing.manualGrant && 'bg-ui-accent/12 text-ui-accent'">{{ plan(team.billing.plan) }}</span></div>
          <div class="break-words text-[13px] text-ui-text-muted">{{ ownerAccount(team) }}</div>
          <div class="truncate text-[13px] text-ui-text-muted">{{ subscriptionSummary(team) }}</div>
          <div v-if="team.billing.manualGrant" class="text-[13px] text-ui-text-muted">{{ t("billing.grantPlan") }}: {{ plan(team.billing.manualGrant.plan) }} · {{ team.billing.manualGrant.expiresAt ? date(team.billing.manualGrant.expiresAt) : t("billing.grantNoExpiry") }}</div>
        </div>
        <UiButton class="shrink-0" @click="openGrant(team)">{{ t("billing.manageGrant") }}</UiButton>
      </li>
    </ul>
    <p v-else class="m-0 py-4 text-sm text-ui-text-muted">{{ t(filter.trim() ? "billing.noMatchingTeams" : "billing.noTeams") }}</p>
  </section>
  <ConfirmDialog
    v-if="changing"
    :title="t('billing.manageGrant')"
    :description="`${changing.name} · ${ownerAccount(changing)}. ${t('billing.manualGrantHint')}`"
    :confirm-label="t('billing.saveGrant')"
    tone="primary"
    :confirm="() => save(changing!)"
    @close="changing = undefined"
  >
    <div class="mt-4 grid gap-3">
      <label class="text-sm">{{ t("billing.grantPlan") }}
        <select v-model="grantPlan" class="ui-input mt-1">
          <option value="none">{{ t("billing.removeGrant") }}</option>
          <option v-for="item in ['free', 'go', 'pro', 'enterprise']" :key="item" :value="item">{{ plan(item) }}</option>
        </select>
      </label>
      <label v-if="grantPlan !== 'none'" class="text-sm">{{ t("billing.grantExpiry") }}
        <input v-model="expiry" type="datetime-local" class="ui-input mt-1" />
      </label>
      <label class="text-sm">{{ t("billing.grantReason") }}
        <textarea v-model="reason" maxlength="2000" class="ui-input mt-1" />
      </label>
    </div>
  </ConfirmDialog>
</template>
