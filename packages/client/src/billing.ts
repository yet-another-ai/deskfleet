export type BillingPlan = "free" | "go" | "pro" | "enterprise" | "selfHosted"
export type BillingInterval = "month" | "year"
export interface BillingPrice {
  plan: "go" | "pro"
  interval: BillingInterval
  unitAmount: number
  currency: string
}
export interface TeamBilling {
  /** Configured Stripe prices; null when the provider could not be reached. */
  prices?: BillingPrice[] | null
  plan: BillingPlan
  limits: { maxActiveSessions: number | null; maxTurnsPerSession: number | null; maxMembers: number | null; turnBytes: number | null }
  usage: { activeSessionCount: number; memberCount: number; relayedBytes: string }
  period: { start: string; end: string } | null
  nextResetAt: string | null
  enterpriseOverride: boolean
  subscription: { plan: "go" | "pro"; status: string; paidThrough: string | null; cancelAtPeriodEnd: boolean } | null
  paymentsAvailable: boolean
  canManageBilling: boolean
  /** Sales mailbox for Enterprise contact. Null/undefined when unset. */
  enterpriseContactEmail?: string | null
}
export interface AdminTeamBilling {
  id: string
  name: string
  /** The Team Owner, for identifying Teams with the same name. */
  owner: { id: string; name: string; email: string }
  billing: TeamBilling
}
