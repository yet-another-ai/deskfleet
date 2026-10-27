<script setup lang="ts">
import { Info } from "@lucide/vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { Team } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { fileSize } from "../../services/file-format.ts"
import UiButton from "../common/UiButton.vue"
import IconButton from "../common/IconButton.vue"

const props = defineProps<{ team: Team }>()
const { t } = useI18n()
const id = useId()
const central = useAccountSession()!.central
const busy = ref(false)
const actionError = ref("")
const checkoutIds = new Map<string, string>()
const { state, isLoading, error, executeImmediate } = useAsyncState(() => central.billing(props.team.id), undefined)
watch(() => props.team.id, () => { actionError.value = ""; void executeImmediate() })
useEventListener(window, "focus", () => { void executeImmediate() })
const currentPlan = computed(() => t(`billing.plan.${state.value?.plan ?? 'free'}`))
const metrics = computed(() => {
  if (!state.value) return []
  const { limits, usage, nextResetAt } = state.value
  return [
    { key: "traffic", label: t("team.relayedTraffic"), hint: t("billing.trafficHint"), period: nextResetAt && limits.turnBytes !== null && limits.turnBytes > 0 ? t("billing.resets", { date: new Date(nextResetAt).toLocaleString() }) : t("team.usageCurrent"), used: Number(usage.relayedBytes), limit: limits.turnBytes, amount: fileSize(Number(usage.relayedBytes)), capacity: limits.turnBytes === null ? "∞" : fileSize(limits.turnBytes) },
    { key: "sessions", label: t("team.activeSessions"), hint: t("team.activeSessionsHint"), period: t("team.usageCurrent"), used: usage.activeSessionCount, limit: limits.maxActiveSessions, amount: String(usage.activeSessionCount), capacity: String(limits.maxActiveSessions ?? "∞") },
    { key: "members", label: t("team.usageMembers"), hint: t("team.usageMembersHint"), period: t("team.usageCurrent"), used: usage.memberCount, limit: limits.maxMembers, amount: String(usage.memberCount), capacity: String(limits.maxMembers ?? "∞") },
  ]
})
const manageExisting = computed(() => state.value?.subscription && (["go", "pro"].includes(state.value.plan) || !["canceled", "incomplete_expired"].includes(state.value.subscription.status)))
async function pay(plan?: "go" | "pro") {
  busy.value = true; actionError.value = ""
  try {
    if (plan) {
      const key = `${props.team.id}:${plan}`
      const requestId = checkoutIds.get(key) ?? crypto.randomUUID()
      checkoutIds.set(key, requestId)
      await central.checkout(props.team.id, plan, requestId)
    } else await central.billingPortal(props.team.id)
  } catch (reason) { actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`" class="mb-8">
    <div class="mb-3 flex items-center justify-between gap-3"><h2 :id="`${id}-title`" class="ui-section-title">{{ t("team.plansUsage") }}</h2><UiButton :disabled="isLoading" @click="executeImmediate()">{{ t("auth.refresh") }}</UiButton></div>
    <p v-if="isLoading" role="status" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("team.usageLoading") }}</p>
    <div v-else-if="error" class="ui-card flex items-center justify-between gap-4 p-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ t("team.usageError") }}</p>
      <UiButton class="shrink-0" @click="executeImmediate()">{{ t("team.usageRetry") }}</UiButton>
    </div>
    <div v-else-if="state" class="grid gap-3">
      <div class="ui-card grid gap-3 p-4">
        <h3 class="m-0 font-medium">{{ currentPlan }}</h3>
        <p class="m-0 text-sm text-ui-text-muted">{{ state.plan === 'free' ? t("billing.freeDescription") : t("billing.unlimitedDescription") }}</p>
        <p v-if="state.subscription?.paidThrough" class="m-0 text-xs text-ui-text-muted">{{ t(state.subscription.cancelAtPeriodEnd ? "billing.ends" : "billing.paidThrough", { date: new Date(state.subscription.paidThrough).toLocaleString() }) }}</p>
        <p v-if="state.enterpriseOverride && state.subscription" class="m-0 text-sm text-ui-text-muted">{{ t("billing.enterpriseSubscription") }}</p>
        <div v-if="state.canManageBilling && state.paymentsAvailable" class="flex flex-wrap gap-2">
          <template v-if="!manageExisting && !state.enterpriseOverride">
            <UiButton variant="primary" :loading="busy" @click="pay('go')">{{ t("billing.chooseGo") }}</UiButton>
            <UiButton :loading="busy" @click="pay('pro')">{{ t("billing.choosePro") }}</UiButton>
          </template>
          <UiButton v-if="state.subscription" :loading="busy" @click="pay()">{{ t("billing.manage") }}</UiButton>
        </div>
        <p v-if="actionError" role="alert" class="m-0 text-sm text-ui-danger">{{ actionError }}</p>
      </div>
      <div v-for="metric in metrics" :key="metric.key" :data-team-usage="metric.key" class="ui-card p-4">
        <div class="mb-4 flex items-center justify-between gap-4">
          <div><div class="flex items-center gap-1"><h3 :id="`${id}-${metric.key}`" class="m-0 text-sm font-medium">{{ metric.label }}</h3><IconButton :icon="Info" :label="metric.hint" class="-my-1" /></div><p class="m-0 mt-1 text-xs text-ui-text-muted">{{ metric.period }}</p></div>
          <span class="ui-badge shrink-0">{{ metric.limit === null ? t("team.unlimited") : metric.limit === 0 ? t("billing.notIncluded") : currentPlan }}</span>
        </div>
        <p class="m-0 mb-2 text-sm tabular-nums" data-team-usage-amount>{{ metric.amount }} / {{ metric.capacity }}</p>
        <div role="progressbar" :aria-labelledby="`${id}-${metric.key}`" :aria-valuetext="`${metric.amount} / ${metric.capacity}`" :aria-valuenow="metric.limit ? Math.min(100, metric.used / metric.limit * 100) : undefined" :aria-valuemin="metric.limit ? 0 : undefined" :aria-valuemax="metric.limit ? 100 : undefined" class="h-1.5 overflow-hidden rounded-full bg-ui-hover"><div v-if="metric.limit" class="h-full bg-ui-text-muted" :style="{ width: `${Math.min(100, metric.used / metric.limit * 100)}%` }" /></div>
      </div>
    </div>
  </section>
</template>
