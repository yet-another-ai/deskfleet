# Stripe subscription operations

The hosted service sells monthly and yearly Team subscriptions through Stripe
Checkout and Billing Portal. Self-hosted mode is the default and rejects payment
configuration. Prices and currency are deployment choices; the repository
contains no live keys or provisioned Stripe objects.

## Configuration

Set `DESKFLEET_DEPLOYMENT_MODE=hosted` to enforce Free/Go/Pro limits. With no Stripe
configuration, hosted Free and manually assigned Enterprise still work. To enable
payments, configure all of:

| Variable | Value |
| --- | --- |
| `DESKFLEET_STRIPE_SECRET_KEY` | Stripe test or live secret/restricted key with access to customers, Prices, subscriptions, invoices, Checkout, and Billing Portal |
| `DESKFLEET_STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's webhook endpoint |
| `DESKFLEET_STRIPE_GO_PRICE_ID` | Active monthly recurring Price for Go |
| `DESKFLEET_STRIPE_PRO_PRICE_ID` | Active monthly recurring Price for Pro |
| `DESKFLEET_STRIPE_GO_YEARLY_PRICE_ID` | Active yearly recurring Price for Go |
| `DESKFLEET_STRIPE_PRO_YEARLY_PRICE_ID` | Active yearly recurring Price for Pro |
| `DESKFLEET_STRIPE_PORTAL_CONFIGURATION_ID` | Billing Portal configuration for monthly Go/Pro only |
| `DESKFLEET_STRIPE_YEARLY_PORTAL_CONFIGURATION_ID` | Billing Portal configuration for yearly Go/Pro only |

All four Prices must belong to the same Product, share the same currency, use
quantity one, and have a positive fixed amount. Go must be cheaper than Pro for
each interval. The four Price IDs must be distinct, and the two Portal
configuration IDs must be distinct. Go includes 2 GiB and Pro 20 GiB of TURN per
monthly usage period (anchored to the subscription); neither limits members,
Sessions, or turns. Checkout accepts `interval` of `month` or `year` and selects
the matching Price. No trials, quantity-based seat charges, or metered overage
are exposed. Create and validate these objects separately in test mode before
providing live configuration.

Optional Enterprise sales contact (independent of Stripe; works for self-hosters
too):

| Variable | Value |
| --- | --- |
| `DESKFLEET_ENTERPRISE_CONTACT_EMAIL` | Mailbox shown as a Contact us action on Plans & Usage. When unset, the Enterprise contact offer is hidden. |

`DESKFLEET_AUTH_WEB_URL` supplies Checkout and Portal return URLs. The browser
returns to the paying Team's Plans & Usage settings section. This redirect grants
no entitlements; only a server-verified paid invoice can establish paid coverage.

## Billing Portal

Create two Portal configurations—one monthly and one yearly—each with:

- `subscription_update.enabled=true` and `default_allowed_updates=["price"]`.
- Exactly the two configured Prices for that interval on their shared Product
  (monthly Go/Pro, or yearly Go/Pro). Do not mix intervals in one configuration:
  Stripe schedules or invoices using raw `unit_amount`, so a yearly Price is
  usually larger than a monthly Price and would invert Go↔Pro upgrade/downgrade
  timing across intervals.
- `subscription_update.proration_behavior="always_invoice"`.
- `subscription_update.schedule_at_period_end.conditions` containing
  `{ "type": "decreasing_item_amount" }`.
- `subscription_cancel.enabled=true` and `mode="at_period_end"`.
- `invoice_history.enabled=true` and `payment_method_update.enabled=true`.

When opening the Portal, the server selects the configuration that matches the
Team's current subscription interval. Plan changes inside the Portal therefore
stay on the same monthly or yearly cadence. Changing billing interval requires
cancelling (at period end) and starting a new Checkout for the other interval.

The server validates the selected configuration before issuing a Portal session.
Stripe only supports scheduled price downgrades on the same Product; see
[Portal configuration](https://docs.stripe.com/customer-management/configure-portal).
Paid upgrades can take effect after invoice confirmation; downgrades and
cancellation retain the current paid plan until period end. A failed payment must
not grant the newly selected plan, even when Stripe's descriptive subscription
status or items have already changed. See
[subscription pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates).

## Webhooks and reconciliation

Register `POST /api/billing/stripe/webhook` for Checkout completion, subscription
changes/deletion, and invoice payment success/failure. The supported event list is
in `apps/server/src/billing/webhook.rs`. The gateway pins Stripe API version
`2024-06-20`; event payloads are used as object identifiers, then current objects
are retrieved and checked. Preserve the webhook's original request bytes.

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

The subscription's billing anchor determines monthly UTC boundaries, clamping a
missing day to month end without losing the original day. Plan changes preserve
current usage; Enterprise traffic remains counted and consumes a restored paid
allowance after revocation. Enterprise assignment does not cancel Stripe billing.
Only Site Admin can change the override, after recent authentication, with an audit
record. Team administrators manage payments; other members can inspect usage.

The Site Admin Team endpoint uses an ID cursor and a maximum page size of 100.
Profiles and usage summaries are read in batches, with one shared collector-state
read per page. The shared client follows the cursor to preserve the existing
administration view.

TURN totals sum sent bytes on each side of a saved peer grant. A database lease
selects the collector, and missing/stale metering is visible in the API. Stale
metering denies new metered relay grants; it does not interrupt issued grants.
Redis Pub/Sub cannot reconstruct dropped traffic. This is a threshold for new
access, not an exact byte cutoff or automatic excess charge.

## Verification and operation

Focused tests cover real PostgreSQL capacity races, monthly boundaries, paid
coverage expiry, overrides, event deduplication, and operation leases. A local
Stripe HTTP fixture verifies Checkout retries/replacement and paid/unpaid plan
changes without contacting Stripe. Webhook tests verify raw-body signatures and
replay timing. These tests do not replace a Stripe test-mode checkout against the
operator's actual Prices, Portal configuration, and webhook setup.

No live payment is performed during development checks. Monitor reconciliation
warnings and metering freshness. Refunds/disputes and account closure are managed
by the operator in this first release; there is no automatic refund or credit
balance. Team deletion is rejected once the Team owns a Stripe customer/subscription
mapping or a checkout attempt, or while a billing operation is active. This
retains financial records even after cancellation. A separate financial closure
workflow is required before removing such a Team.
