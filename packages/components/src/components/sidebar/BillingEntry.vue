<script setup lang="ts">
import { CreditCard } from "@lucide/vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { trackEvent } from "../../services/analytics.ts"
import UiButton from "../common/UiButton.vue"

const account = useAccountSession()!
const { t } = useI18n()
const scope = computed(() => JSON.stringify([account.account.value.user?.id, account.team.value?.id, account.team.value?.role]))
const { state, executeImmediate: load } = useAsyncState(async () => {
  const key = scope.value
  const team = account.team.value
  if (!team) return undefined
  return { key, billing: await account.central.billing(team.id) }
}, undefined, { immediate: false, resetOnExecute: false })
watch(scope, () => { void load() }, { immediate: true })
useEventListener(window, "focus", () => { void load() })
const billing = computed(() => state.value?.key === scope.value ? state.value.billing : undefined)
const upgrade = computed(() => billing.value?.plan === "free" && billing.value.paymentsAvailable && billing.value.canManageBilling && !billing.value.manualGrant && !billing.value.enterpriseOverride && (!billing.value.subscription || ["canceled", "incomplete_expired"].includes(billing.value.subscription.status)))
const action = computed(() => upgrade.value ? "upgrade" as const : "view" as const)
function open(): void {
  trackEvent("billing_entry_clicked", { source: "sidebar", current_plan: billing.value?.plan, action: action.value })
  account.openSettings("plans")
}
</script>

<template>
  <div class="shrink-0 px-3 py-3" data-billing-entry>
    <div class="mb-2 flex min-w-0 items-center justify-between gap-2 text-xs text-ui-text-muted">
      <span class="truncate">{{ account.team.value?.name }}</span>
      <span v-if="billing" class="shrink-0">{{ t(`billing.plan.${billing.plan}`) }}</span>
    </div>
    <UiButton class="w-full" :variant="upgrade ? 'primary' : 'default'" @click="open">
      <CreditCard :size="15" :stroke-width="1.75" aria-hidden="true" />
      {{ t(upgrade ? "billing.upgradePlan" : "billing.plansAndBilling") }}
    </UiButton>
  </div>
</template>
