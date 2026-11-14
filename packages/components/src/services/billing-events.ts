import type { BillingInterval, BillingPlan } from "@deskfleet/client/billing"
import { HttpError } from "@deskfleet/client/http-central"

type CheckoutMetadata = { target_plan: "go" | "pro"; interval: BillingInterval; request_id: string }
type PortalMetadata = { source: "manage" | "payment_recovery" }
export type BillingReturn = "checkout_success" | "checkout_cancel" | "portal"

export interface BillingAnalyticsEvents {
  billing_entry_clicked: { source: "sidebar" | "team_menu"; current_plan?: BillingPlan; action?: "upgrade" | "view" }
  billing_plans_viewed: { current_plan: BillingPlan; can_manage: boolean; payments_available: boolean; has_subscription: boolean; enterprise_contact_available: boolean }
  billing_checkout: CheckoutMetadata & { outcome: "started" | "failed"; reason?: string }
  billing_portal: PortalMetadata & { outcome: "started" | "failed"; reason?: string }
  billing_payment_recovery_viewed: { subscription_status: "past_due" | "unpaid" | "incomplete" }
  billing_returned: { source: BillingReturn }
  billing_enterprise_contact_clicked: Record<string, never>
}

/** An untrusted return marker describes navigation, never a verified conversion. */
export function billingReturn(value: string | null): BillingReturn | undefined {
  return value === "checkout_success" || value === "checkout_cancel" || value === "portal" ? value : undefined
}

/** Do not send exception messages, Stripe URLs, or arbitrary provider codes. */
export function billingFailure(reason: unknown): string {
  const codes = ["payments_unavailable", "subscription_exists", "checkout_finished", "checkout_pending", "payment_required", "payment_provider_unavailable", "invalid_portal_configuration"]
  if (!(reason instanceof HttpError)) return "network_or_open_failed"
  if (reason.code && codes.includes(reason.code)) return reason.code
  if (reason.status === 401 || reason.status === 403) return "access_denied"
  if (reason.status >= 500) return "server_error"
  return "request_rejected"
}
