<script lang="ts">
// The account shell outlives route and MachineSurface remounts; release its cache with it.
const accountImpressions = new WeakMap<object, Set<string>>()
</script>

<script setup lang="ts">
import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { trackEvent } from "../../services/analytics.ts"
import type { TurnAllowanceState } from "../../services/entitlement-events.ts"
import UiButton from "../common/UiButton.vue"
import AgentNotice from "./AgentNotice.vue"

/** Finite per-Session turn allowances: a quiet count, a warning near the end, and the pause reason once reached. */
const props = defineProps<{ snapshot: AgentSnapshot }>()
const account = useAccountSession()
const { t } = useI18n()
const { state, executeImmediate: load } = useAsyncState(async () => account?.teamId.value ? account.central.billing(account.teamId.value) : undefined, undefined)
watch(() => account?.teamId.value, () => { void load() })
useEventListener(window, "focus", () => { void load() })
const inherited = computed(() => props.snapshot.session.inheritedTurnCount ?? 0)
const used = computed(() => inherited.value + props.snapshot.turns.filter(turn => turn.consumed).length)
const limit = computed(() => state.value?.limits.maxTurnsPerSession ?? null)
const remaining = computed(() => limit.value === null ? null : Math.max(0, limit.value - used.value))
const detail = computed(() => inherited.value ? t("billing.inheritedTurns", { count: inherited.value }) : undefined)
const allowanceState = computed<TurnAllowanceState | undefined>(() => remaining.value === 0 ? "reached"
  : props.snapshot.session.turnLimitReason ? "blocked"
  : remaining.value !== null && remaining.value <= 5 ? "near_limit" : undefined)
// Repeated snapshots and billing refreshes must not repeat an impression for this Session.
const observed = (account && accountImpressions.get(account)) || new Set<string>()
if (account) accountImpressions.set(account, observed)
watch([() => props.snapshot.session.id, allowanceState], ([sessionId, value]) => {
  if (!value) return
  const key = JSON.stringify([account?.account.value.user?.id, account?.teamId.value, account?.machineId.value, sessionId, value])
  if (observed.has(key)) return
  observed.add(key)
  trackEvent("session_turn_allowance_viewed", { state: value, used_turns: used.value, ...(limit.value === null ? {} : { turn_limit: limit.value }) })
}, { immediate: true })
function viewPlans(): void {
  if (allowanceState.value) trackEvent("session_turn_plans_clicked", { source: allowanceState.value })
  account?.openSettings("plans")
}
</script>

<template>
  <AgentNotice v-if="snapshot.session.turnLimitReason" tone="warning" :text="snapshot.session.turnLimitReason" :detail="t('billing.resumeHint')">
    <UiButton v-if="account" size="sm" class="shrink-0" @click="viewPlans">{{ t("billing.viewPlans") }}</UiButton>
  </AgentNotice>
  <AgentNotice v-else-if="remaining !== null && remaining <= 5" tone="warning" :text="t('billing.turnsLeft', { remaining, limit }, remaining)" :detail="detail">
    <UiButton v-if="account" size="sm" class="shrink-0" @click="viewPlans">{{ t("billing.viewPlans") }}</UiButton>
  </AgentNotice>
  <p v-else-if="limit !== null" class="m-0 px-1 text-xs text-ui-text-muted tabular-nums" data-session-turns>
    {{ t("billing.sessionTurns", { used, limit }) }}<template v-if="detail"> · {{ detail }}</template>
  </p>
</template>
