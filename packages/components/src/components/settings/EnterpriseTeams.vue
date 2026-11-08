<script setup lang="ts">
import { Search } from "@lucide/vue"
import { useDebounceFn } from "@vueuse/core"
import { ref, watch } from "vue"
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
const PAGE_SIZE = 20
const filter = ref("")
const appliedFilter = ref("")
const teams = ref<AdminTeamBilling[]>([])
const nextCursor = ref<string | null>(null)
/** The cursor for each loaded page; the first page has none. */
const history = ref<Array<string | null>>([null])
const pageIndex = ref(0)
const isLoading = ref(true)
const error = ref<unknown>()
const changing = ref<AdminTeamBilling>()
/** One page request together with the history it would commit on success. */
interface PageTarget {
  cursor: string | null
  search: string
  index: number
  history: Array<string | null>
}
let revision = 0
let retryTarget: PageTarget | undefined

async function load(target: PageTarget): Promise<boolean> {
  retryTarget = target
  const current = ++revision
  isLoading.value = true
  error.value = undefined
  try {
    const page = await props.api.billingTeams({ limit: PAGE_SIZE, search: target.search, ...(target.cursor ? { cursor: target.cursor } : {}) })
    if (current !== revision) return false
    teams.value = page.teams
    nextCursor.value = page.nextCursor
    appliedFilter.value = target.search
    history.value = target.history
    pageIndex.value = target.index
    return true
  } catch (reason) {
    if (current === revision) error.value = reason
    return false
  } finally {
    if (current === revision) isLoading.value = false
  }
}
function searchFirstPage(search: string): void {
  void load({ cursor: null, search, index: 0, history: [null] })
}
const debouncedSearch = useDebounceFn(() => searchFirstPage(filter.value.trim()), 250)
watch(filter, () => debouncedSearch())
function retry(): void {
  if (retryTarget) void load(retryTarget)
}
async function nextPage(): Promise<void> {
  if (!nextCursor.value || isLoading.value) return
  const cursor = nextCursor.value
  await load({
    cursor,
    search: appliedFilter.value,
    index: pageIndex.value + 1,
    history: [...history.value.slice(0, pageIndex.value + 1), cursor],
  })
}
async function previousPage(): Promise<void> {
  if (pageIndex.value === 0 || isLoading.value) return
  const index = pageIndex.value - 1
  await load({ cursor: history.value[index]!, search: appliedFilter.value, index, history: history.value.slice(0, index + 1) })
}
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
  await load({ cursor: history.value[pageIndex.value]!, search: appliedFilter.value, index: pageIndex.value, history: history.value })
}
void load({ cursor: null, search: "", index: 0, history: [null] })
</script>

<template>
  <header class="mb-8">
    <h1 class="ui-page-title">{{ t("billing.enterpriseTeams") }}</h1>
    <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("billing.manualGrantHint") }}</p>
  </header>
  <div class="relative mb-3">
    <Search :size="15" :stroke-width="1.75" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-text-faint" aria-hidden="true" />
    <input v-model="filter" type="search" class="ui-input pl-8" name="team-filter" :aria-label="t('billing.filterTeams')" :placeholder="t('billing.filterTeams')" maxlength="200" />
  </div>
  <p v-if="isLoading && !teams.length" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
  <div v-else-if="error && !teams.length" class="flex items-center justify-between gap-4">
    <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
    <UiButton @click="retry">{{ t("auth.retry") }}</UiButton>
  </div>
  <template v-else>
    <div v-if="error" class="mb-3 flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
      <UiButton @click="retry">{{ t("auth.retry") }}</UiButton>
    </div>
    <ul v-if="teams.length" class="ui-card m-0 list-none p-0" :aria-busy="isLoading || undefined">
      <li v-for="team in teams" :key="team.id" class="ui-card-row py-3" :data-enterprise-team="team.id">
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
    <nav v-if="teams.length" class="mt-4 flex items-center justify-between gap-3" :aria-label="t('billing.pagination')">
      <UiButton :disabled="isLoading || pageIndex === 0" @click="previousPage">{{ t("billing.previousPage") }}</UiButton>
      <span class="text-[13px] text-ui-text-muted" aria-live="polite">{{ t("billing.pageNumber", { page: pageIndex + 1 }) }}</span>
      <UiButton :disabled="isLoading || !nextCursor" @click="nextPage">{{ t("billing.nextPage") }}</UiButton>
    </nav>
  </template>
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
