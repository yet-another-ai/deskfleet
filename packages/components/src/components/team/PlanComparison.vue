<script setup lang="ts">
import { Check, Minus } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { BillingInterval, BillingPrice, PlanCatalogEntry, TeamBilling } from "@deskfleet/client/billing"
import { fileSize } from "../../services/file-format.ts"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{
  billing: TeamBilling
  interval: BillingInterval
  offers: boolean
  showSuperAgent: boolean
  pending?: "go" | "pro" | "portal"
}>()
const emit = defineEmits<{ select: [plan: "go" | "pro"] }>()
const { t, locale } = useI18n()
// Enterprise is offered separately through the sales contact.
const plans = computed(() => props.billing.planCatalog.filter(
  (entry): entry is PlanCatalogEntry & { plan: "free" | "go" | "pro" } => entry.plan !== "enterprise",
))
const quotaFeatures = [
  { key: "maxActiveSessions", label: "team.activeSessions" },
  { key: "maxTurnsPerSession", label: "billing.turnsPerSession" },
  { key: "maxMembers", label: "team.usageMembers" },
  { key: "superAgentTokens", label: "billing.comparison.monthlyTokens" },
] as const
const features = computed(() => quotaFeatures.filter(feature => feature.key !== "superAgentTokens" || props.showSuperAgent))
function price(plan: string) {
  return props.billing.prices?.find(value => value.plan === plan && value.interval === props.interval)
}
function amount(value: BillingPrice) {
  const formatter = new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { style: "currency", currency: value.currency, currencyDisplay: "code" })
  // Stripe keeps ISK and UGX in hundredths for backwards-compatible charge amounts.
  const digits = ["isk", "ugx"].includes(value.currency.toLowerCase()) ? 2 : (formatter.resolvedOptions().maximumFractionDigits ?? 2)
  return formatter.format(value.unitAmount / 10 ** digits)
}
function relay(bytes: number | null) {
  if (bytes === null) return t("team.unlimited")
  if (bytes === 0) return t("billing.notIncluded")
  if (bytes % 1_073_741_824) return fileSize(bytes)
  return t("billing.comparison.relayAmount", { amount: bytes / 1_073_741_824 })
}
</script>

<template>
  <div class="plan-comparison grid gap-3">
    <article v-for="entry in plans" :key="entry.plan" class="ui-card flex min-w-0 flex-col overflow-hidden" :class="billing.plan === entry.plan ? 'ring-1 ring-ui-accent' : ''" :data-plan-comparison="entry.plan" :data-billing-offer="offers && entry.plan !== 'free' ? entry.plan : undefined">
      <div class="flex flex-col gap-3 p-5">
        <div class="flex min-h-7 flex-wrap items-center justify-between gap-2">
          <h3 class="m-0 text-lg font-semibold">{{ t(`billing.plan.${entry.plan}`) }}</h3>
          <span v-if="billing.plan === entry.plan" class="ui-badge bg-ui-accent/10 text-ui-accent">{{ t("billing.comparison.current") }}</span>
        </div>
        <div class="min-h-16">
          <p v-if="price(entry.plan)" class="m-0 text-2xl font-semibold tabular-nums">{{ amount(price(entry.plan)!) }}<span class="ml-1 text-xs font-normal text-ui-text-muted">{{ t(`billing.comparison.per.${interval}`) }}</span></p>
          <p v-else class="m-0 text-sm font-medium">{{ t(entry.plan === 'free' ? 'billing.comparison.freePrice' : 'billing.comparison.priceUnavailable') }}</p>
          <p v-if="price(entry.plan)" class="m-0 mt-1 text-xs text-ui-text-muted">{{ t(`billing.offerInterval.${interval}`) }}</p>
        </div>
      </div>
      <dl class="m-0 flex-1 border-t border-ui-border-strong px-5">
        <div v-for="feature in features" :key="feature.key" class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ui-border-strong py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t(feature.label) }}</dt>
          <dd class="m-0 text-sm font-semibold tabular-nums">{{ entry[feature.key] ?? t("team.unlimited") }}</dd>
        </div>
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ui-border-strong py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t("billing.comparison.monthlyRelay") }}</dt>
          <dd class="m-0 flex items-center gap-1.5 text-sm font-semibold tabular-nums" :class="entry.turnBytes === 0 ? 'text-ui-text-muted' : 'text-ui-accent'">
            <Minus v-if="entry.turnBytes === 0" :size="14" aria-hidden="true" />{{ relay(entry.turnBytes) }}
          </dd>
        </div>
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ui-border-strong py-3" :data-plan-team-turn="entry.teamTurnServers">
          <dt class="text-[13px] text-ui-text-muted">{{ t("billing.comparison.teamTurn") }}</dt>
          <dd v-if="entry.teamTurnServers" class="m-0 flex items-center gap-1.5 text-sm"><Check :size="15" class="text-ui-accent" aria-hidden="true" />{{ t("billing.comparison.included") }}</dd>
          <dd v-else class="m-0 flex items-center gap-1.5 text-sm text-ui-text-muted"><Minus :size="14" aria-hidden="true" />{{ t("billing.notIncluded") }}</dd>
        </div>
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t("billing.comparison.direct") }}</dt>
          <dd class="m-0 flex items-center gap-1.5 text-sm"><Check :size="15" class="text-ui-accent" aria-hidden="true" />{{ t("billing.comparison.included") }}</dd>
        </div>
      </dl>
      <div v-if="offers && entry.plan !== 'free'" class="p-5 pt-2">
        <UiButton :variant="entry.plan === 'go' ? 'primary' : 'default'" class="w-full" :loading="pending === entry.plan" :disabled="!!pending" @click="emit('select', entry.plan)">{{ t("billing.upgradeTo", { plan: t(`billing.plan.${entry.plan}`) }) }}</UiButton>
      </div>
    </article>
  </div>
</template>

<style scoped>
.plan-comparison {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
}
</style>
