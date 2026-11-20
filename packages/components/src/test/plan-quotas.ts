import type { BillingPlan, PlanCatalogEntry, PlanQuota } from "@deskfleet/client/billing"

export const quotaFixture: Record<BillingPlan, PlanQuota> = {
  free: { maxActiveSessions: 3, maxTurnsPerSession: 30, maxMembers: 3, turnBytes: 0, superAgentTokens: 0, teamTurnServers: false },
  go: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2_147_483_648, superAgentTokens: 0, teamTurnServers: false },
  pro: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 21_474_836_480, superAgentTokens: 0, teamTurnServers: true },
  enterprise: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: null, superAgentTokens: 0, teamTurnServers: true },
  selfHosted: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: null, superAgentTokens: null, teamTurnServers: true },
}

export function planCatalogFixture(): PlanCatalogEntry[] {
  return (["free", "go", "pro", "enterprise"] as const).map(plan => ({ plan, ...quotaFixture[plan] }))
}

export function adminPlanQuotasFixture() {
  return [...planCatalogFixture(), { plan: "selfHosted" as const, ...quotaFixture.selfHosted }]
}
