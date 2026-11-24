import { useAsyncState, useEventListener } from "@vueuse/core"
import { computed, effectScope, getCurrentScope, onScopeDispose, watch, type ComputedRef } from "vue"
import type { TeamBilling } from "@deskfleet/client/billing"
import type { AccountSession } from "./useAccountSession.ts"

interface SharedTeamBilling {
  billing: ComputedRef<TeamBilling | undefined>
  canUpgrade: ComputedRef<boolean>
  refresh: () => Promise<{ key: string; billing: TeamBilling } | undefined>
}

interface SharedEntry {
  api: SharedTeamBilling
  consumers: number
  stop: () => void
}

const cache = new WeakMap<AccountSession, SharedEntry>()

const emptyBilling: SharedTeamBilling = {
  billing: computed(() => undefined),
  canUpgrade: computed(() => false),
  refresh: async () => undefined,
}

/** Shares one Team billing loader per AccountSession across sidebar consumers (BillingEntry & AccountMenu). */
export function useTeamBilling(account: AccountSession | undefined): SharedTeamBilling {
  if (!account) return emptyBilling

  let entry = cache.get(account)
  if (!entry) {
    const detached = effectScope(true)
    const api = detached.run(() => {
      const scope = computed(() => JSON.stringify([
        account.account.value.user?.id,
        account.team.value?.id,
        account.team.value?.role,
      ]))
      const { state, executeImmediate: load } = useAsyncState<{ key: string; billing: TeamBilling } | undefined>(async () => {
        const key = scope.value
        const team = account.team.value
        if (!team) return undefined
        return { key, billing: await account.central.billing(team.id) }
      }, undefined, { immediate: false, resetOnExecute: false, onError: () => {} })

      watch(scope, () => { void load() }, { immediate: true })
      useEventListener(window, "focus", () => { void load() })

      const billing = computed(() => state.value?.key === scope.value ? state.value.billing : undefined)
      const canUpgrade = computed(() =>
        billing.value?.plan === "free"
        && billing.value.paymentsAvailable
        && billing.value.canManageBilling
        && !billing.value.manualGrant
        && !billing.value.enterpriseOverride
        && (!billing.value.subscription || ["canceled", "incomplete_expired"].includes(billing.value.subscription.status)),
      )
      return { billing, canUpgrade, refresh: load }
    })!

    entry = { api, consumers: 0, stop: () => detached.stop() }
    cache.set(account, entry)
  }

  entry.consumers += 1
  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (!entry) return
      entry.consumers -= 1
      if (entry.consumers <= 0) {
        entry.stop()
        cache.delete(account)
      }
    })
  }

  return entry.api
}
