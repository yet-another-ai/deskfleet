# Stripe subscription operations

The hosted service sells monthly and yearly Team subscriptions through Stripe
Checkout and Billing Portal. Self-hosted mode is the default and rejects payment
configuration. Prices and currency are deployment choices; the repository
contains no live keys or provisioned Stripe objects.

## Configuration

Set `DESKFLEET_DEPLOYMENT_MODE=hosted` to enforce Free/Go/Pro limits. With no Stripe
configuration, hosted Free and manually assigned Enterprise still work. To enable
payments, configure all seven settings:

| Variable | Value |
| --- | --- |
| `DESKFLEET_STRIPE_SECRET_KEY` | Stripe test or live secret/restricted key with access to customers, Prices, subscriptions, invoices, Checkout, and Billing Portal |
| `DESKFLEET_STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's webhook endpoint |
| `DESKFLEET_STRIPE_GO_PRICE_ID` | Active monthly recurring Price for Go |
| `DESKFLEET_STRIPE_PRO_PRICE_ID` | Active monthly recurring Price for Pro |
| `DESKFLEET_STRIPE_GO_YEARLY_PRICE_ID` | Active yearly recurring Price for Go |
| `DESKFLEET_STRIPE_PRO_YEARLY_PRICE_ID` | Active yearly recurring Price for Pro |
| `DESKFLEET_STRIPE_PORTAL_CONFIGURATION_ID` | One Billing Portal configuration containing all four Go/Pro Prices |

Create two Stripe Products: Go and Pro. Each Product has one monthly and one
yearly recurring Price. The four Price IDs must be distinct, share the same
currency, use quantity one, and have a positive fixed amount. Go must be cheaper
than Pro for each interval. Go includes 2 GiB and Pro 20 GiB of TURN per
monthly usage period (anchored to the subscription); neither limits members,
Sessions, or turns. Checkout accepts `interval` of `month` or `year` and selects
the matching Price. No trials, quantity-based seat charges, or metered overage
are exposed. Create and validate these objects separately in test mode before
providing live configuration.

Checkout explicitly sets `subscription_data[billing_mode][type]=flexible`.
This integration targets Stripe API `2026-09-30.endive` and flexible subscriptions.

Optional Enterprise sales contact (independent of Stripe; works for self-hosters
too):

| Variable | Value |
| --- | --- |
| `DESKFLEET_ENTERPRISE_CONTACT_EMAIL` | Mailbox shown as a Contact us action on Plans & Usage. When unset, the Enterprise contact offer is hidden. |

`DESKFLEET_AUTH_WEB_URL` supplies Checkout and Portal return URLs. The browser
returns to the paying Team's Plans & Usage settings section. This redirect grants
no entitlements; only a server-verified paid invoice can establish paid coverage.

## Billing Portal

Create one Portal configuration with:

- `subscription_update.enabled=true` and `default_allowed_updates=["price"]`.
- Exactly the four configured Prices under their two Products: Go monthly/yearly
  under Go, and Pro monthly/yearly under Pro.
- `subscription_update.proration_behavior="always_invoice"`.
- No scheduled updates: `subscription_update.schedule_at_period_end.conditions=[]`.
- `subscription_cancel.enabled=true` and `mode="at_period_end"`.
- `invoice_history.enabled=true` and `payment_method_update.enabled=true`.

The server validates this configuration before issuing a Portal session. Customers
can change both plan and monthly/yearly interval in that same Portal. Upgrades
and downgrades apply immediately with Stripe's native proration; cancellation
remains scheduled for period end. See
[Portal configuration](https://docs.stripe.com/customer-management/configure-portal).

With flexible billing, the Portal records the scheduled cancellation in the
subscription's numeric `cancel_at` timestamp while Stripe's
`cancel_at_period_end` remains false. DeskFleet derives its cancellation indicator
from `cancel_at`; removing the scheduled cancellation clears that timestamp.

`always_invoice` makes the change produce an immediate proration invoice for
payment confirmation. Stripe calculates charges for the new selection and
credits for unused time. DeskFleet applies the selected plan and paid-through
deadline only after verifying the matching paid invoice, including a zero-total
invoice settled by credits. A failed upgrade retains the previous verified plan
and coverage; changing Stripe's descriptive status or subscription item alone
does not grant paid access. See
[subscription changes](https://docs.stripe.com/billing/subscriptions/change-price)
and [prorations](https://docs.stripe.com/billing/subscriptions/prorations).

## Webhooks and reconciliation

Register `POST /api/billing/stripe/webhook` for Checkout completion, subscription
changes/deletion, and invoice payment success/failure. The supported event list is
in `apps/server/src/billing/webhook.rs`. The gateway pins Stripe API version
`2026-09-30.endive` for all requests; configure the webhook endpoint to the same
version using snapshot events. Event payloads supply object identifiers, then
current objects are retrieved and checked. Preserve the webhook's original
request bytes.

Reconciliation reads the subscription item's `current_period_end`, the invoice's
`parent.subscription_details.subscription`, and each line's
`pricing.price_details.price`. Invoice `status=paid` establishes settlement;
this API version has no invoice `paid` boolean. The Portal's returned
scheduled-update conditions must be empty for immediate changes.

The endpoint verifies Stripe's HMAC signature with a five-minute timestamp
window, checks test/live mode, and stores supported events in PostgreSQL before
acknowledging them. Independent background tasks process the event inbox and
repair customer/subscription state, so a slow periodic repair cannot hold up
unrelated payment events. Each task claims at most 25 items per five-second tick.
Repair claims select one due customer atomically, use a three-minute fencing
lease, and schedule the next check after one minute on success or five minutes
on failure. The inbox claim index excludes processed and exhausted events and
matches receipt order. Unique event IDs and database leases fence duplicate and
concurrent workers. See [Stripe webhook verification](https://docs.stripe.com/webhooks/signature).

Checkout request IDs are UUIDs and are reused after an uncertain result. A Team
has at most one open purchase attempt; replacing an unpaid checkout first
expires it. Completed checkouts block new purchases while reconciliation finishes.
An existing subscription is managed through the Portal. The worker can recover a
completed purchase whose Checkout response was lost using server-owned metadata.

A valid subscription must belong to the saved customer and Team and contain one
configured Price at quantity one. Only a matching paid invoice and covered period
can extend `paidThrough`. Receipt order and a browser redirect cannot extend it.
At that deadline, unrenewed paid access becomes Free with no grace period.
Existing data and accepted work remain, while subsequent work uses Free limits.

## Usage and administration

DeskFleet stores a monthly TURN usage anchor when it first adopts a subscription.
Its UTC boundaries clamp a missing day to month end without losing the original
day. Flexible billing retains Stripe's numeric `billing_cycle_anchor` when the
billing interval changes; the subscription item's `current_period_end` determines
the period that its matching paid invoice must cover. DeskFleet retains its own
stored usage anchor for the same subscription. Plan and interval changes preserve
the current usage period and its accumulated bytes; they do not grant a fresh
monthly allowance. See
[flexible billing behavior](https://docs.stripe.com/billing/subscriptions/billing-mode/compare).

A replacement subscription adopts its own anchor. Enterprise traffic remains
counted and consumes a restored paid allowance after revocation. Enterprise
assignment does not cancel Stripe billing.
Only Site Admin can change the override, after recent authentication, with an audit
record. Only the Team owner manages payments; administrators and other members
can inspect usage. Transferring ownership leaves the same customer, subscription,
payment methods, and billing contact in place; it does not stop existing renewal
charges.

The Site Admin Team endpoint uses an ID cursor and a maximum page size of 100.
Each row includes the owner's name and email to distinguish Teams with the same name.
Profiles and usage summaries are read in batches, with one shared collector-state
read per page. The shared client follows the cursor to preserve the existing
administration view.

TURN totals sum sent bytes on each side of a saved peer grant. A database lease
selects the collector, and missing/stale metering is visible in the API. Stale
metering denies new metered relay grants; it does not interrupt issued grants.
Redis Pub/Sub cannot reconstruct dropped traffic. This is a threshold for new
access, not an exact byte cutoff or automatic excess charge.

## Verification and operation

Optional Statsig conversion reporting uses `DESKFLEET_STATSIG_SERVER_KEY` and
`DESKFLEET_STATSIG_ENVIRONMENT` (default `production`). Use the same project/tier
as frontend analytics and keep the server key out of `VITE_*` configuration.
The server emits verified invoice payments/failures and subscription lifecycle
facts through a separate durable outbox; browser returns record navigation only.
See [analytics](analytics.md#payment-funnel) for event names, actor attribution,
minor-unit amounts, replay handling, and delivery semantics.

Focused tests cover real PostgreSQL capacity races, monthly boundaries, paid
coverage expiry, overrides, event deduplication, and operation leases. A local
Stripe HTTP fixture verifies Checkout retries/replacement and paid/unpaid plan
changes without contacting Stripe. Webhook tests verify raw-body signatures and
replay timing. These tests do not replace a Stripe test-mode checkout against the
operator's actual Prices, Portal configuration, and webhook setup. Include
immediate upgrades and downgrades, monthly-to-yearly and yearly-to-monthly changes,
cross-plan interval changes, credit-settled invoices, failed upgrade payments,
preserved TURN usage, and cancellation at period end. Confirm Checkout creates a
flexible subscription and Portal cancellation sets and clears `cancel_at`.

No live payment is performed during development checks. Monitor reconciliation
warnings and metering freshness. Refunds/disputes and account closure are managed
by the operator in this first release. Stripe may apply native invoice credits
from proration; DeskFleet has no custom wallet or automatic refund workflow.
Team deletion is rejected once the Team owns a Stripe customer/subscription
mapping or a checkout attempt, or while a billing operation is active. This
retains financial records even after cancellation. A separate financial closure
workflow is required before removing such a Team.
