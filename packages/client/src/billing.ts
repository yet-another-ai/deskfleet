export type BillingPlan = "free" | "go" | "pro" | "enterprise" | "selfHosted"
export interface TeamBilling {
  plan: BillingPlan
  limits: { maxActiveSessions: number | null; maxTurnsPerSession: number | null; maxMembers: number | null; turnBytes: number | null }
  usage: { activeSessionCount: number; memberCount: number; relayedBytes: string }
  period: { start: string; end: string } | null
  nextResetAt: string | null
  enterpriseOverride: boolean
  subscription: { plan: "go" | "pro"; status: string; paidThrough: string | null; cancelAtPeriodEnd: boolean } | null
  paymentsAvailable: boolean
  canManageBilling: boolean
}
export interface AdminTeamBilling { id: string; name: string; billing: TeamBilling }
