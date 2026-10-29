# Product analytics and billing conversions

Web and Electron use `@statsig/js-client` through the shared Vue frontend.
`packages/components/src/services/analytics.ts` owns one client per renderer
document. It survives selected-Machine application remounts and shuts down when
the root application unmounts. The SDK handles event batching and browser
page-lifecycle flushing. The Rust backend separately emits verified billing
facts through a durable delivery queue. The daemon does not send product events.

## Build configuration

Analytics is disabled when `VITE_STATSIG_CLIENT_KEY` is missing or blank. In that
case no Statsig client is created, no events are sent, gates return false, and
experiment parameters return their supplied defaults.

Use a Statsig **client** SDK key (`client-...`), which is public and embedded in
the bundle. Never put a server secret key in a `VITE_*` variable.

```sh
export VITE_STATSIG_CLIENT_KEY=client-REPLACE_ME
export VITE_STATSIG_ENVIRONMENT=development
mise run dev
# The same process environment applies to mise run desktop:dev,
# mise run web:build, and mise run desktop:build.
```

`VITE_STATSIG_ENVIRONMENT` defaults to the Vite mode (`development` or
`production`). Set it to the tier configured in Statsig, such as `staging`.
Vite also reads the app's environment files: `apps/web/.env*` for Web and
`apps/desktop/src/renderer/.env*` for the Electron renderer. Exporting the
variables in the invoking shell works for both. Changing the deployed server's
runtime environment does not modify a compiled frontend.

For tagged releases, configure these optional variables in the GitHub
`production` environment. The build workflow supplies them to Web and Electron
only for production releases. PR, main, and manual Build runs do not bind that
environment and leave Statsig disabled. Keep production values out of repository
and organization variables; see [release configuration](ci.md#tagged-releases)
for the environment's tag restrictions. Leave the key unset for releases that
should not collect analytics.

Initialization runs in the background with a one-second async timeout. Product
startup does not await it. The SDK uses available cached/default evaluations
after ordinary network failures; a rejected initialization leaves the UI's
defaults usable. Event delivery is best effort.

## Identity and data

The Statsig user contains the authenticated account UUID as `userID`, the
selected Team as `customIDs.teamID`, and `custom.platform` as `web` or `desktop`.
Account status and Team changes replace this identity; logout removes both IDs.
Public authentication pages and startup before
account status arrives use the SDK's anonymous stable ID. Team and Machine
switches do not create a new analytics client. Events include `team_id`,
`team_role`, and `current_plan` for the selected Team. Plan context starts as
`unknown` and refreshes from authoritative billing data on selection, window
focus, and billing-page load. Shared response sequencing rejects older requests.
Joining a Team omits these event metadata fields because an invite token does
not reveal the target Team before acceptance; use account-based join metrics.

DeskFleet events carry only the fields listed below. They do not include account
names/email, prompts, Session titles, file paths, provider configuration, raw RPC
parameters, URL queries, or route resource IDs. Automatic page URL metadata is
disabled. Auto Capture and Session Replay plugins are not installed.

Checkout request IDs connect frontend attempts to the server's created-checkout
event. Billing events also retain opaque invoice/event identifiers for
deduplication. These identifiers are not payment credentials.

The core SDK still manages its normal device/session identifiers, SDK metadata,
local evaluation cache, and diagnostics. Its exception reporting can include
stack traces and script URLs; the custom-event field policy does not disable
these SDK diagnostics.

| Event | When | Metadata |
| --- | --- | --- |
| `app_opened` | Main UI or authentication root mounts | None |
| `page_viewed` | Successful named route navigation, including initial load; authentication root mounts | `page`: route name or `authentication` |
| `workspace_created` | Workspace creation returns successfully | `directory_count` |
| `session_created` | Session creation returns successfully | `context`: `worktree`/`directory`; `scope`: `workspace`/`machine` |
| `session_forked` | Session fork returns successfully | `context`: `worktree`/`directory` |
| `session_archived` | Archive returns successfully | None |
| `session_restored` | Restore returns successfully | None |
| `input_submitted` | Input submission returns successfully | `delivery`: `backlog`/`steer` |

Numeric metadata is converted to strings for Statsig. Aborted/failed navigation
does not emit a page view. Successful navigation between two Sessions emits a
new page view with the same `session` page name. Mermaid popout windows are not
instrumented. The event catalog measures interactive acknowledgments; background
journal replay and the separate **Check result** recovery path do not backfill
events after a lost operation response. These events are not a usage ledger.

## Payment funnel

The payment UI records intent and navigation; **`billing_invoice_paid` from the
server is the conversion event**. Opening Checkout, returning through its success
URL, or viewing an active subscription never emits a client-side paid event.

| Frontend event | Meaning and dimensions |
| --- | --- |
| `billing_plans_viewed` | Once per mounted Plans view after loading; effective plan, billing permission, payment/subscription/contact availability |
| `billing_interval_selected` | Actual month/year selection change; previous and selected interval |
| `billing_checkout_started` | Each attempt; `target_plan`, `interval`, `request_id` |
| `billing_checkout_opened` | Checkout API and external-page opening completed; same attempt dimensions |
| `billing_checkout_failed` | The attempt failed; same dimensions plus an allowlisted reason, never exception text |
| `billing_portal_started` / `billing_portal_opened_client` / `billing_portal_failed` | Billing management or payment-recovery action; `source=manage`/`payment_recovery` |
| `billing_payment_recovery_viewed` | Once per payment-problem status per view for a billing admin; `past_due`, `unpaid`, or `incomplete` |
| `billing_returned` | Allowlisted `checkout_success`, `checkout_cancel`, or `portal` return marker for an accessible Team; navigation only |
| `billing_enterprise_contact_clicked` | Contact-link intent; no mailbox/address is sent |

Month/year and Go/Pro attempts retain separate request IDs. A retry of an
uncertain attempt reuses its ID; count distinct `request_id` for unique Checkout
intents. Completion after leaving settings is still recorded for the same
account/Team; it is omitted if the account or selected Team has changed.

The billing server accepts these optional **runtime** settings:

| Variable | Meaning |
| --- | --- |
| `DESKFLEET_STATSIG_SERVER_KEY` | Statsig server secret key for event delivery; keep out of all frontend/Vite variables |
| `DESKFLEET_STATSIG_ENVIRONMENT` | Tier for server events, default `production`; match the frontend tier |

Without the server key, no billing analytics facts are enqueued and no delivery
requests run. No key is committed. Enable the frontend and server keys for the
same Statsig project to join exposures, usage, and verified conversion.
Register `teamID` under the project's Custom IDs settings to analyze Team-level
conversion and experiments. Use account-level metrics for individual actions and
Team-level metrics for subscriptions shared by multiple members.
See [Statsig group analytics](https://docs.statsig.com/guides/logging-events#group-analytics).

| Server event | Authority and dimensions |
| --- | --- |
| `billing_checkout_created` | Stripe created/returned the persisted Checkout attempt; plan, interval, `request_id`, authenticated actor |
| `billing_portal_opened` | Stripe issued a Portal session; exact authenticated actor; does not prove a Portal change |
| `billing_invoice_paid` | Server fetched and verified a paid invoice belonging to the Team/customer/subscription and a configured Price/currency; plan, interval, currency, billing reason |
| `billing_invoice_payment_failed` | Verified signed failure notification plus fetched invoice ownership; retains each failed payment-attempt number even if payment later succeeds |
| `billing_subscription_cancel_scheduled` | Verified subscription projection changes to cancel at period end |
| `billing_subscription_cancel_reverted` | Verified projection restores automatic renewal |
| `billing_subscription_ended` | Verified projection becomes canceled |

Invoice event `value` is in the currency's **minor units**, not a universal dollar
amount. Filter by currency before summing. `billing_reason` distinguishes
`subscription_create`, `subscription_cycle`, `subscription_update`, and `other`.
Use `billing_invoice_paid` + `subscription_create` for initial paid conversion;
track renewals and paid upgrades separately. Annual purchases retain
`interval=year`; TURN periods still reset monthly.

Server events use `customIDs.teamID` and, when available, the original Checkout
actor's UUID as `userID`, matching the frontend account. Later invoice events
mark `attribution=checkout_actor`; this does not assert who operated Stripe
Portal. Older purchases with no recorded actor use `attribution=team_only` and
omit `userID`. Portal creation records its actual initiating actor separately.

Migration 10 adds the Checkout actor, signed failure-attempt fields, and
`cp_billing_analytics`. Invoice IDs deduplicate facts across different webhook
types and periodic repair. Checkout creation and subscription projections commit
with their corresponding events. An independent leased worker delivers up to 25 due events
per pass to `https://api.statsig.com/v1/log_event`, with five-second HTTP
timeouts and increasing retry delays capped at one hour. Outages in Statsig do
not hold the payment reconciliation worker. Delivery retains event ID, original
timestamp, actor, and value across retries.

Statsig does not deduplicate custom events. Delivery is **at least once**: an
accepted HTTP request whose response is lost can be resent. `metadata.event_id`
is stable for distinct-event analysis; use the database billing ledger for
financial reconciliation, not an unqualified sum of Statsig deliveries.
[Statsig event logging](https://docs.statsig.com/guides/logging-events).

## Features covered by membership allowances

These events measure use of the affected functionality, not just visits to
Plans & Usage. They carry selected Team/plan context described above.

| Event | Functional scope |
| --- | --- |
| `session_capacity_action` | `create`, `fork`, `restore` with `attempt`/`success`/`failure`; context and scope when known |
| `input_submit_action` | Submitted backlog/steer input with attempt/success/failure; submission is not a consumed provider turn |
| `member_invite_action` | Invitation attempt/success/failure and invited role; no email |
| `team_join_action` | Invite acceptance attempt/success/failure; no invite token; acceptance is the member-capacity boundary |
| `session_turn_allowance_viewed` | `near_limit`/`reached`/`blocked`, consumed-turn count including inheritance, and finite limit when known |
| `session_turn_plans_clicked` | Upgrade entry from a near-limit, reached, or blocked turn allowance |
| `peer_granted` | Actual agent/terminal/desktop/files/ports peer grant; relay access `allowed`, `unconfigured`, `free_plan`, `turn_quota_exhausted`, or `metering_unavailable` |
| `peer_connection` | First observed connected/failed outcome per grant, feature, and relay access; `transport=unknown` |

Turn-warning impressions are deduplicated for the same account, Team, Machine,
Session, and warning boundary across route remounts. Functional failure events
describe failed client attempts: the existing transports do not expose a
specific structured capacity code, so analytics does not infer one from error
messages. Invitation creation does not consume a member seat.
An admission pause with no confirmed exhausted allowance is `blocked`, so an
unavailable entitlement service is not counted as quota exhaustion. Async
functional outcomes are omitted when the account or selected Team has changed.

Peer grants indicate permitted fallback, not proof that TURN was selected.
Connection telemetry does not measure transferred bytes. Billing's server-side
TURN collector remains authoritative for usage. Cancellation, account changes,
revocation, and expiry are not connection failures. Desktop file/port peers
forward typed observations from main through the existing narrow bridge; the
renderer owns Statsig. Internal target-Team correlation drops late events after
Team navigation instead of assigning them to the new Team.

## Feature gates and experiments

The helpers are ready for future UI experiments; this integration does not
change any existing product feature based on a remote gate.

```ts
import { useFeatureGate, useExperimentParameter } from "../services/analytics.ts"

const showNewComposer = useFeatureGate("new_composer")
const actionLabel = useExperimentParameter("composer_copy", "label", "Send")
```

Both return readonly computed refs and update when SDK values or the signed-in
user change. Until the current user's evaluation is ready they return false or
the supplied fallback. `analyticsReady` exposes evaluation readiness when a
consumer needs it; it remains false when analytics is disabled. Parameter
fallbacks support strings, numbers, and booleans.

Statsig records an exposure when a computed value actually reads a gate or
experiment. Create/read these helpers where the feature is used; do not eagerly
read every experiment during startup. Use remote gates only for frontend
presentation and rollout. Authorization, subscription quotas, and resource
ownership remain enforced by the server and daemon.

## Network and validation

`packages/client/src/analytics-config.ts` owns explicit initialization and event
endpoints. Dynamic endpoint fallbacks are disabled. Configured Electron builds
permit only the three Statsig origins in addition to the existing development
HMR policy: `https://featureassets.org`, `https://prodregistryv2.org`, and
`https://statsigapi.net` (SDK exceptions). Without a key, production keeps
`connect-src 'none'`. A Web host that supplies its own CSP must allow these
origins alongside the application's API/peer requirements.

Focused tests cover disabled configuration, identity replacement and logout,
initialization failure, reactive/default evaluations, route metadata, root
teardown, action success/failure payloads, payment funnel attribution, peer
outcomes, and Electron CSP. Server HTTP fixtures and PostgreSQL tests cover
verified invoice facts, replay deduplication, immutable delivery retries, and
lease/transaction behavior. To verify a real
Statsig project, build with its client key, perform a listed action, and inspect
the event in Statsig. No project key is committed to this repository.

SDK reference: [Statsig JavaScript client](https://docs.statsig.com/client/javascript-sdk).
