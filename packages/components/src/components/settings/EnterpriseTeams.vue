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
function description(team: AdminTeamBilling): string {
  const value = billing(team)
  if (!team.billing.enterpriseOverride) return t(value ? "billing.grantWithSubscription" : "billing.grantDescription", { plan: value && plan(value.plan) })
  // The server restores the subscription's plan only while it still covers the Team; otherwise Free.
  return t(value ? "billing.revokeWithSubscription" : "billing.revokeDescription", { plan: value && plan(value.plan) })
}
async function toggle(team: AdminTeamBilling): Promise<void> {
  await props.confirmed(() => props.api.setEnterprise(team.id, !team.billing.enterpriseOverride))
  await load()
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mt-10">
    <h2 :id="`${id}-title`" class="ui-section-title mb-1">{{ t("billing.enterpriseTeams") }}</h2>
    <p class="m-0 mb-3 text-[13px] text-ui-text-muted">{{ t("billing.enterpriseHint") }}</p>
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
          <div class="flex items-center gap-2 text-sm"><span class="truncate">{{ team.name }}</span><span class="ui-badge shrink-0" :class="team.billing.enterpriseOverride && 'bg-ui-accent/12 text-ui-accent'">{{ plan(team.billing.plan) }}</span></div>
          <div class="break-words text-[13px] text-ui-text-muted">{{ ownerAccount(team) }}</div>
          <div class="truncate text-[13px] text-ui-text-muted">{{ subscriptionSummary(team) }}</div>
        </div>
        <UiButton class="shrink-0" :variant="team.billing.enterpriseOverride ? 'danger' : 'default'" @click="changing = team">{{ t(team.billing.enterpriseOverride ? "billing.revokeEnterprise" : "billing.grantEnterprise") }}</UiButton>
      </li>
    </ul>
    <p v-else class="m-0 py-4 text-sm text-ui-text-muted">{{ t(filter.trim() ? "billing.noMatchingTeams" : "billing.noTeams") }}</p>
  </section>
  <ConfirmDialog
    v-if="changing"
    class="break-words"
    :title="t(changing.billing.enterpriseOverride ? 'billing.revokeTitle' : 'billing.grantTitle', { team: changing.name })"
    :description="`${ownerAccount(changing)}. ${description(changing)}`"
    :confirm-label="t(changing.billing.enterpriseOverride ? 'billing.revokeEnterprise' : 'billing.grantEnterprise')"
    :tone="changing.billing.enterpriseOverride ? 'danger' : 'primary'"
    :confirm="() => toggle(changing!)"
    @close="changing = undefined"
  />
</template>
