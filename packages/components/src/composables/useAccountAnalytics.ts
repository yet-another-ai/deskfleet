import { onScopeDispose, watch } from "vue"
import { useEventListener } from "@vueuse/core"
import type { AccountSession } from "./useAccountSession.ts"
import { analyticsEnabled, beginAnalyticsPlanRefresh, identifyAnalytics } from "../services/analytics.ts"

export function useAccountAnalytics(session: AccountSession): void {
  let revision = 0
  async function refreshPlan(): Promise<void> {
    const current = ++revision
    const team = session.team.value
    if (!analyticsEnabled() || !session.account.value.user || !team) return
    const updatePlan = beginAnalyticsPlanRefresh(team.id)
    try {
      const value = await session.central.billing(team.id)
      if (revision === current) updatePlan(value.plan)
    } catch { /* Analytics context must not interrupt account initialization. */ }
  }
  watch([() => session.account.value.user?.id, () => session.team.value?.id, () => session.team.value?.role], ([id, teamId, role]) => {
    identifyAnalytics(id, teamId && role ? { id: teamId, role } : undefined)
    void refreshPlan()
  }, { immediate: true, flush: "sync" })
  useEventListener(window, "focus", () => { void refreshPlan() })
  onScopeDispose(() => { revision++ })
}
