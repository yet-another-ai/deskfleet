<script setup lang="ts">
import { ExternalLink, Info, Mail } from "@lucide/vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { BillingInterval } from "@deskfleet/client/billing"
import type { Team } from "@deskfleet/client/central"
import { HttpError } from "@deskfleet/client/http-central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { fileSize } from "../../services/file-format.ts"
import IconButton from "../common/IconButton.vue"
import UiButton from "../common/UiButton.vue"
import AgentNotice from "../session/AgentNotice.vue"
import UsageMeter from "./UsageMeter.vue"

const props = defineProps<{ team: Team }>()
const { t, locale } = useI18n()
const id = useId()
const central = useAccountSession()!.central
const pending = ref<"go" | "pro" | "portal">()
const checkoutOpened = ref(false)
const actionError = ref<string>()
const interval = ref<BillingInterval>("month")
// A retried checkout reuses its request id so the server can return the same attempt.
const checkoutIds = new Map<string, string>()
const { state, isLoading, error, executeImmediate: load } = useAsyncState(() => central.billing(props.team.id), undefined)
// Checkout and the billing portal finish in another tab or the system browser.
useEventListener(window, "focus", () => { void load() })

const date = (value: string) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium" }).format(new Date(value))
const count = (value: number) => String(value)
const plans = ["go", "pro"] as const
const subscription = computed(() => state.value?.subscription ?? undefined)
const paymentProblem = computed(() => ["past_due", "unpaid", "incomplete"].includes(subscription.value?.status ?? ""))
const status = computed(() => {
  const value = subscription.value
  if (!value || state.value?.enterpriseOverride) return undefined
  if (paymentProblem.value) return { text: t("billing.paymentIssue"), tone: "bg-ui-danger/10 text-ui-danger" }
  if (!value.paidThrough) return undefined
  return value.cancelAtPeriodEnd
    ? { text: t("billing.ends", { date: date(value.paidThrough) }), tone: "bg-ui-warning/12 text-ui-warning" }
    : { text: t("billing.renews", { date: date(value.paidThrough) }), tone: "" }
})
// An existing or still-payable subscription is changed in the portal, never by a second checkout.
const hasSubscription = computed(() => !!subscription.value && (["go", "pro"].includes(state.value!.plan) || !["canceled", "incomplete_expired"].includes(subscription.value.status)))
const billingAdmin = computed(() => !!state.value?.canManageBilling && state.value.paymentsAvailable)
const offers = computed(() => billingAdmin.value && !hasSubscription.value && !state.value!.enterpriseOverride)
const enterpriseContact = computed(() => {
  const email = state.value?.enterpriseContactEmail?.trim()
  return email && !state.value?.enterpriseOverride ? email : undefined
})
const caption = computed(() => {
  const value = state.value
  if (value?.limits.turnBytes === 0) return t("billing.trafficNotIncluded")
  if (!value?.limits.turnBytes) return undefined
  const remaining = Math.max(0, value.limits.turnBytes - Number(value.usage.relayedBytes))
  const left = t("billing.remaining", { amount: fileSize(remaining) })
  return value.nextResetAt ? `${left} · ${t("billing.resets", { date: date(value.nextResetAt) })}` : left
})

async function open(target: "go" | "pro" | "portal"): Promise<void> {
  if (pending.value) return
  pending.value = target
  actionError.value = undefined
  try {
    if (target === "portal") await central.billingPortal(props.team.id)
    else {
      const key = `${props.team.id}:${target}:${interval.value}`
      const requestId = checkoutIds.get(key) ?? crypto.randomUUID()
      checkoutIds.set(key, requestId)
      try { await central.checkout(props.team.id, target, requestId, interval.value) }
      catch (reason) {
        if (reason instanceof HttpError && reason.code === "checkout_finished") checkoutIds.delete(key)
        throw reason
      }
      // Opening succeeded; it replaces any previous unpaid attempt for this Team.
      checkoutIds.clear()
      checkoutOpened.value = true
    }
  } catch (reason) { actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = undefined }
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <header class="mb-8">
      <h1 :id="`${id}-title`" class="ui-page-title">{{ t("team.plansUsage") }}</h1>
      <p class="m-0 mt-1 truncate text-[13px] text-ui-text-muted">{{ team.name }}</p>
    </header>
    <p v-if="isLoading && !state" role="status" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("team.usageLoading") }}</p>
    <div v-else-if="error && !state" class="ui-card flex items-center justify-between gap-4 p-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ t("team.usageError") }}</p>
      <UiButton class="shrink-0" @click="load()">{{ t("team.usageRetry") }}</UiButton>
    </div>
    <div v-else-if="state" class="flex flex-col gap-3">
      <AgentNotice v-if="paymentProblem && billingAdmin" tone="danger" :text="t('billing.paymentIssueDescription')">
        <UiButton size="sm" class="shrink-0" :loading="pending === 'portal'" @click="open('portal')">{{ t("billing.fixPayment") }}</UiButton>
      </AgentNotice>
      <AgentNotice v-if="checkoutOpened && !hasSubscription" tone="progress" :text="t('billing.checkoutOpened')" />
      <div class="ui-card shadow-ui-card" data-team-plan>
        <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p class="m-0 text-base font-semibold">{{ t(`billing.plan.${state.plan}`) }}</p>
              <span v-if="status" class="ui-badge" :class="status.tone">{{ status.text }}</span>
            </div>
            <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(`billing.planDescription.${state.plan}`) }}</p>
            <p v-if="state.enterpriseOverride && subscription" class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("billing.enterpriseSubscription", { plan: t(`billing.plan.${subscription.plan}`) }) }}</p>
          </div>
          <UiButton v-if="billingAdmin && subscription" class="shrink-0" :loading="pending === 'portal'" @click="open('portal')">{{ t("billing.manage") }}<ExternalLink :size="13" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        </div>
        <div class="border-t border-ui-border">
          <UsageMeter data-team-usage="traffic" :label="t('team.relayedTraffic')" :hint="t('billing.trafficHint')" :used="Number(state.usage.relayedBytes)" :limit="state.limits.turnBytes" :format="fileSize" :caption="caption" />
          <UsageMeter data-team-usage="sessions" class="border-t border-ui-border" :label="t('team.activeSessions')" :hint="t('team.activeSessionsHint')" :used="state.usage.activeSessionCount" :limit="state.limits.maxActiveSessions" :format="count" />
          <UsageMeter data-team-usage="members" class="border-t border-ui-border" :label="t('team.usageMembers')" :hint="t('team.usageMembersHint')" :used="state.usage.memberCount" :limit="state.limits.maxMembers" :format="count" />
          <div data-team-usage="turns" class="flex min-h-14 items-center justify-between gap-4 border-t border-ui-border px-4 py-3.5">
            <div class="flex min-w-0 items-center gap-1">
              <h3 class="m-0 truncate text-sm font-normal">{{ t("billing.turnsPerSession") }}</h3>
              <IconButton :icon="Info" :label="t('billing.turnsPerSessionHint')" class="-my-1" />
            </div>
            <span v-if="state.limits.maxTurnsPerSession === null" class="ui-badge shrink-0">{{ t("team.unlimited") }}</span>
            <span v-else class="shrink-0 text-sm tabular-nums">{{ t("billing.turnsPerSessionLimit", { count: state.limits.maxTurnsPerSession }) }}</span>
          </div>
        </div>
      </div>
      <div v-if="offers" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-3" data-billing-interval>
          <p class="m-0 text-[13px] text-ui-text-muted">{{ t("billing.chooseInterval") }}</p>
          <div role="group" :aria-label="t('billing.chooseInterval')" class="flex rounded-lg border border-ui-border bg-ui-hover p-1">
            <button type="button" class="cursor-pointer rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ui-accent" :class="interval === 'month' ? 'bg-ui-surface text-ui-text shadow-sm' : 'text-ui-text-muted hover:text-ui-text'" :aria-pressed="interval === 'month'" data-billing-interval-option="month" @click="interval = 'month'">{{ t("billing.interval.month") }}</button>
            <button type="button" class="cursor-pointer rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ui-accent" :class="interval === 'year' ? 'bg-ui-surface text-ui-text shadow-sm' : 'text-ui-text-muted hover:text-ui-text'" :aria-pressed="interval === 'year'" data-billing-interval-option="year" @click="interval = 'year'">{{ t("billing.interval.year") }}</button>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div v-for="plan in plans" :key="plan" class="ui-card flex flex-col gap-3 p-4" :data-billing-offer="plan">
            <div>
              <p class="m-0 text-sm font-semibold">{{ t(`billing.plan.${plan}`) }}</p>
              <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(`billing.offer.${plan}`) }}</p>
              <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(`billing.offerInterval.${interval}`) }}</p>
            </div>
            <UiButton :variant="plan === 'go' ? 'primary' : 'default'" class="mt-auto" :loading="pending === plan" :disabled="!!pending" @click="open(plan)">{{ t("billing.upgradeTo", { plan: t(`billing.plan.${plan}`) }) }}</UiButton>
          </div>
        </div>
      </div>
      <p v-else-if="state.plan === 'free' && state.paymentsAvailable && !state.canManageBilling" class="m-0 text-[13px] text-ui-text-muted">{{ t("billing.askAdmin") }}</p>
      <div v-if="enterpriseContact" class="ui-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-billing-offer="enterprise">
        <div class="min-w-0">
          <p class="m-0 text-sm font-semibold">{{ t("billing.plan.enterprise") }}</p>
          <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("billing.offer.enterprise") }}</p>
        </div>
        <a class="ui-button shrink-0" :href="`mailto:${enterpriseContact}`">{{ t("billing.contactEnterprise") }}<Mail :size="13" :stroke-width="1.75" aria-hidden="true" /></a>
      </div>
      <p v-if="actionError" role="alert" class="m-0 text-sm text-ui-danger">{{ actionError }}</p>
    </div>
  </section>
</template>
