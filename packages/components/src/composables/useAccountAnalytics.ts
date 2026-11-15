import { onScopeDispose, watch } from "vue"
import { useEventListener } from "@vueuse/core"
import { readMarketingAttribution, readStoredTelemetryConsent } from "@deskfleet/client/marketing-attribution"
import type { AccountSession } from "./useAccountSession.ts"
import { analyticsEnabled, beginAnalyticsPlanRefresh, identifyAnalytics, setSiteTelemetryEnabled, userTelemetryConsent } from "../services/analytics.ts"

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
  watch(() => session.site.value?.telemetryEnabled, enabled => {
    if (enabled !== undefined) setSiteTelemetryEnabled(enabled)
  }, { immediate: true, flush: "sync" })
  watch([
    () => session.account.value.user?.id,
    () => session.site.value?.telemetryEnabled,
    userTelemetryConsent,
  ], ([id, siteEnabled, consented], oldValue) => {
    if (consented && siteEnabled) void refreshPlan()
    if (!id || !siteEnabled) return
    const wasConsented = oldValue?.[2]
    if (!consented && !wasConsented && readStoredTelemetryConsent() !== "declined") return
    void session.central.updateTelemetryConsent?.({
      consented,
      ...(consented ? { attribution: readMarketingAttribution(true) } : {}),
    })?.catch(() => { /* Never block session initialization on telemetry sync. */ })
  }, { immediate: true })
  watch([
    () => session.account.value.user?.id,
    () => session.account.value.user?.email,
    () => session.team.value?.id,
    () => session.team.value?.role,
  ], ([id, email, teamId, role]) => {
    identifyAnalytics(id, teamId && role ? { id: teamId, role } : undefined, email ?? undefined)
    void refreshPlan()
  }, { immediate: true, flush: "sync" })
  useEventListener(window, "focus", () => { void refreshPlan() })
  onScopeDispose(() => { revision++ })
}
