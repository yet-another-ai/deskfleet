import type { TeamBilling } from "@deskfleet/client/billing"

export const freeBilling: TeamBilling = {
  plan: "free", usage: { relayedBytes: "0", activeSessionCount: 1, memberCount: 2 },
  period: null, nextResetAt: null, enterpriseOverride: false, subscription: null,
  limits: { maxActiveSessions: 3, maxTurnsPerSession: 30, maxMembers: 3, turnBytes: 0 },
  prices: [
    { plan: "go", interval: "month", unitAmount: 500, currency: "usd" },
    { plan: "pro", interval: "month", unitAmount: 1500, currency: "usd" },
    { plan: "go", interval: "year", unitAmount: 5000, currency: "usd" },
    { plan: "pro", interval: "year", unitAmount: 15000, currency: "usd" },
  ],
  paymentsAvailable: true, canManageBilling: true,
}
