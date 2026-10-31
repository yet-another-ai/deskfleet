<script setup lang="ts">
import { Check, Minus } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { BillingInterval, BillingPrice, TeamBilling } from "@deskfleet/client/billing"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{
  billing: TeamBilling
  interval: BillingInterval
  offers: boolean
  pending?: "go" | "pro" | "portal"
}>()
const emit = defineEmits<{ select: [plan: "go" | "pro"] }>()
const { t, locale } = useI18n()
// Hosted allowances mirror Plan::limits in crates/control-store/src/billing/mod.rs.
// The current plan always uses the authoritative allowances returned by the server.
const plans = [
  { id: "free", limits: { maxActiveSessions: 3, maxTurnsPerSession: 30, maxMembers: 3, turnBytes: 0 } },
  { id: "go", limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2_147_483_648 } },
  { id: "pro", limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 21_474_836_480 } },
] as const
const features = [
  { key: "maxActiveSessions", label: "team.activeSessions" },
  { key: "maxTurnsPerSession", label: "billing.turnsPerSession" },
  { key: "maxMembers", label: "team.usageMembers" },
] as const
function price(plan: string) {
  return props.billing.prices?.find(value => value.plan === plan && value.interval === props.interval)
}
function amount(value: BillingPrice) {
  const formatter = new Intl.NumberFormat(intlLocale(locale.value as AppLocale), { style: "currency", currency: value.currency, currencyDisplay: "code" })
  // Stripe keeps ISK and UGX in hundredths for backwards-compatible charge amounts.
  const digits = ["isk", "ugx"].includes(value.currency.toLowerCase()) ? 2 : (formatter.resolvedOptions().maximumFractionDigits ?? 2)
  return formatter.format(value.unitAmount / 10 ** digits)
}
function limits(plan: typeof plans[number]) {
  return props.billing.plan === plan.id ? props.billing.limits : plan.limits
}
function relay(plan: typeof plans[number]) {
  const bytes = limits(plan).turnBytes
  if (bytes === null) return t("team.unlimited")
  if (bytes === 0) return t("billing.notIncluded")
  return t("billing.comparison.relayAmount", { amount: bytes / 1_073_741_824 })
}
</script>

<template>
  <div class="plan-comparison grid gap-3">
    <article v-for="plan in plans" :key="plan.id" class="ui-card flex min-w-0 flex-col overflow-hidden" :class="billing.plan === plan.id ? 'ring-1 ring-ui-accent' : ''" :data-plan-comparison="plan.id" :data-billing-offer="offers && plan.id !== 'free' ? plan.id : undefined">
      <div class="flex flex-col gap-3 p-5">
        <div class="flex min-h-7 flex-wrap items-center justify-between gap-2">
          <h3 class="m-0 text-lg font-semibold">{{ t(`billing.plan.${plan.id}`) }}</h3>
          <span v-if="billing.plan === plan.id" class="ui-badge bg-ui-accent/10 text-ui-accent">{{ t("billing.comparison.current") }}</span>
        </div>
        <p class="m-0 min-h-10 text-[13px] text-ui-text-muted">{{ t(`billing.comparison.description.${plan.id}`) }}</p>
        <div class="min-h-16">
          <p v-if="price(plan.id)" class="m-0 text-2xl font-semibold tabular-nums">{{ amount(price(plan.id)!) }}<span class="ml-1 text-xs font-normal text-ui-text-muted">{{ t(`billing.comparison.per.${interval}`) }}</span></p>
          <p v-else class="m-0 text-sm font-medium">{{ t(plan.id === 'free' ? 'billing.comparison.freePrice' : 'billing.comparison.priceUnavailable') }}</p>
          <p v-if="price(plan.id)" class="m-0 mt-1 text-xs text-ui-text-muted">{{ t(`billing.offerInterval.${interval}`) }}</p>
        </div>
      </div>
      <dl class="m-0 flex-1 border-t border-ui-border px-5">
        <div v-for="feature in features" :key="feature.key" class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ui-border py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t(feature.label) }}</dt>
          <dd class="m-0 text-sm font-semibold tabular-nums">{{ limits(plan)[feature.key] ?? t("team.unlimited") }}</dd>
        </div>
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ui-border py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t("billing.comparison.monthlyRelay") }}</dt>
          <dd class="m-0 flex items-center gap-1.5 text-sm font-semibold tabular-nums" :class="limits(plan).turnBytes === 0 ? 'text-ui-text-muted' : 'text-ui-accent'">
            <Minus v-if="limits(plan).turnBytes === 0" :size="14" aria-hidden="true" />{{ relay(plan) }}
          </dd>
        </div>
        <div class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3">
          <dt class="text-[13px] text-ui-text-muted">{{ t("billing.comparison.direct") }}</dt>
          <dd class="m-0 flex items-center gap-1.5 text-sm"><Check :size="15" class="text-ui-accent" aria-hidden="true" />{{ t("billing.comparison.included") }}</dd>
        </div>
      </dl>
      <div v-if="offers && plan.id !== 'free'" class="p-5 pt-2">
        <UiButton :variant="plan.id === 'go' ? 'primary' : 'default'" class="w-full" :loading="pending === plan.id" :disabled="!!pending" @click="emit('select', plan.id)">{{ t("billing.upgradeTo", { plan: t(`billing.plan.${plan.id}`) }) }}</UiButton>
      </div>
    </article>
  </div>
</template>

<style scoped>
.plan-comparison {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
}
</style>
