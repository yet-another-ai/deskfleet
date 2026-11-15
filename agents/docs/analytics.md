# Product analytics, marketing attribution, and billing conversions

Web, Electron, and the VitePress marketing site (`docs/`) share a unified
telemetry layer in `packages/components/src/services/analytics.ts` backed by:

- **`@statsig/js-client`** for product analytics, feature gates, and experiments.
- **Google Tag (`packages/client/src/google-tag.ts`)** supporting `GTM-XXXX`,
  `G-XXXX` (GA4), and `AW-XXXX` (Google Ads) with Google Consent Mode v2.
- **First-touch marketing attribution (`packages/client/src/marketing-attribution.ts`)**
  preserving `gclid`, `gbraid`, `wbraid`, `utm_*`, and `ga_cid` across the website,
  web authentication, desktop browser-login handoff, and server-side Stripe
  paid conversions.

`packages/components/src/services/analytics.ts` owns one client per renderer
document. It survives selected-Machine application remounts and shuts down when
the root application unmounts. The Rust backend separately emits verified billing
facts through a durable delivery queue to both Statsig and GA4 Measurement
Protocol. The daemon does not send product events.

## Privacy gates: site master switch and user opt-in consent

Telemetry requires **two** gates to be enabled before any client SDK (`StatsigClient`
or Google `gtm.js`/`gtag.js`) initializes or any server-side conversion is delivered:

1. **Backend master switch (`SiteSettings.telemetryEnabled`)**:
   - Stored in `cp_site_settings.telemetry_enabled` (Migration 35), defaulting to
     `false` so self-hosted deployments never load third-party scripts or show
     consent prompts unless an administrator turns it on in **Site Administration → General**.
   - Exposed in `GET /api/site`, `GET/PUT /api/admin/site-settings`, and
     `GET /api/auth/config`.
2. **Explicit user opt-in (`userTelemetryConsent`)**:
   - Stored locally in `localStorage["deskfleet-telemetry-consent"]` (`"granted"` or `"declined"`).
   - Default is `false` (unchecked / denied). Google Consent Mode v2 defaults all
     four storage categories (`ad_storage`, `ad_user_data`, `ad_personalization`,
     `analytics_storage`) to `'denied'` before any tag script can load.
   - Users can opt in or out from:
     - The lightweight bottom consent banner on `docs/` (`MarketingConsentBanner.vue`),
     - The default-unchecked checkbox inside the account sign-in card in `WelcomePage.vue`,
     - The toggle in **Settings → Preferences → Privacy & analytics** (`PreferencesSettings.vue`).
   - When signed in with consent enabled, the client syncs consent and first-touch
     attribution to `PUT /api/me/telemetry-consent` (and during desktop browser
     approval via `POST /api/auth/desktop/complete`). Revoking consent (`consented: false`)
     deletes the user's `cp_user_marketing_attribution` row on the server.

## Event routing tiers

| Tier | Helper | Statsig | Google Tag (`GTM-` / `G-` / `AW-`) | Typical events |
| --- | --- | --- | --- | --- |
| `marketing_only` | `trackMarketingEvent` | No | Yes | `marketing_page_viewed`, `marketing_hero_cta_clicked`, `marketing_social_clicked` |
| `acquisition_conversion` | `trackAcquisitionConversion` | Yes | Yes (`send_to` Ads conversion label when configured) | `marketing_download_clicked`, `marketing_install_command_copied`, `marketing_mobile_download_clicked`, `marketing_get_started_clicked` |
| `product_funnel` | `trackEvent` | Yes | Key lifecycle subset only (`app_opened`, `page_viewed`, `account_registered`, `account_verified`, `account_signed_in`, `team_created`, `machine_enrolled`, `billing_checkout`) | Full product event catalog |
| `revenue_conversion` | Rust billing worker | Yes (`billing_invoice_paid`) | Yes (GA4 Measurement Protocol `purchase` on `subscription_create`) | Server-verified Stripe invoice payment |

## Build configuration

Analytics is disabled when no `VITE_STATSIG_CLIENT_KEY`, `VITE_GTM_ID`,
`VITE_GA_MEASUREMENT_ID`, or `VITE_GOOGLE_ADS_ID` is configured, or when either
the site master switch or user consent is off.

Use public client identifiers in `VITE_*` variables. Never put a server secret
key in a `VITE_*` variable.

```sh
export VITE_STATSIG_CLIENT_KEY=client-REPLACE_ME
export VITE_STATSIG_ENVIRONMENT=development
export VITE_DOCS_GA_MEASUREMENT_ID=G-DOCS_STREAM
export VITE_WEB_GA_MEASUREMENT_ID=G-WEB_STREAM
export VITE_DESKTOP_GA_MEASUREMENT_ID=G-DESKTOP_STREAM
export VITE_GOOGLE_ADS_ID=AW-REPLACE_ME
export VITE_GOOGLE_ADS_INSTALL_LABEL=REPLACE_ME
mise run dev
```

### Multi-stream GA4 and Native Firebase configuration

One GA4 Property typically separates data streams by surface. `resolveSurfaceGoogleTagIds`
in `packages/client/src/analytics-config.ts` resolves each surface's stream ID:

| Surface | Primary variables | Fallback chain |
| --- | --- | --- |
| Marketing website (`docs/`) | `VITE_DOCS_GA_MEASUREMENT_ID`, `VITE_DOCS_GTM_ID` | `VITE_GA_MEASUREMENT_ID`, `VITE_GTM_ID` |
| Web client (`apps/web`) | `VITE_WEB_GA_MEASUREMENT_ID`, `VITE_WEB_GTM_ID` | `VITE_APP_GA_MEASUREMENT_ID` / `VITE_APP_GTM_ID` → `VITE_GA_MEASUREMENT_ID` / `VITE_GTM_ID` |
| Desktop client (`apps/desktop`) | `VITE_DESKTOP_GA_MEASUREMENT_ID`, `VITE_DESKTOP_GTM_ID` | `VITE_APP_GA_MEASUREMENT_ID` / `VITE_APP_GTM_ID` → `VITE_GA_MEASUREMENT_ID` / `VITE_GTM_ID` |
| Android (`apps/web/android`) | Native `apps/web/android/app/google-services.json` | Optional `VITE_ANDROID_GA_MEASUREMENT_ID` (never falls back to Web `G-` IDs) |
| iOS (`apps/web/ios`) | Native `apps/web/ios/App/App/GoogleService-Info.plist` | Optional `VITE_IOS_GA_MEASUREMENT_ID` (never falls back to Web `G-` IDs) |

On Android and iOS, `apps/web/src/main.ts` registers `createCapacitorTelemetrySink()`
from `@deskfleet/capacitor-bridge`. Consent changes (`setTelemetryConsent`),
account identity (`setTelemetryUserId`), and forwarded lifecycle events
(`logTelemetryEvent`) are bridged directly to the native Firebase Analytics SDK
(`FirebaseTelemetryBridge.kt` and `FirebaseTelemetryBridge.swift`):

- `apps/web/android/app/google-services.json` and
  `apps/web/ios/App/App/GoogleService-Info.plist` are **gitignored and optional**.
  Open-source checkouts and CI smoke builds without these files compile and run
  cleanly; the native bridge reports `configured: false` and no-ops.
- Both `AndroidManifest.xml` (`firebase_analytics_collection_enabled = false`)
  and `Info.plist` (`FIREBASE_ANALYTICS_COLLECTION_ENABLED = false`) default
  native collection and all four Consent Mode v2 signals (`analytics_storage`,
  `ad_storage`, `ad_user_data`, `ad_personalization`) to disabled until both
  `SiteSettings.telemetryEnabled` and `userTelemetryConsent` are `true`.

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
account email as the standard `email` attribute, the selected Team as
`customIDs.teamID`, and `custom.platform` as the client shell: `web`, `pwa`,
`android`, `ios`, `windows`, `macos`, or `linux`. Email is sent to
Statsig so gates can target individual addresses or email domains; it does not
replace the UUID used for identity and percentage rollouts. Account status,
email, and Team changes replace this identity and refresh gate evaluations;
logout removes both IDs and the email. Accounts without an available email omit
that attribute.

The shell is resolved in this order:

1. The Electron host: `darwin` is `macos`, `win32` is `windows`, and `linux` is `linux`.
2. A Capacitor native app: `ios` or `android`, including when its display mode is standalone.
3. An installed browser app, when `display-mode: standalone` matches or iOS Safari reports `navigator.standalone`: `pwa`.
4. Any other browser tab: `web`.

`windows`, `macos`, and `linux` are the Electron app, not the operating system of a browser or installed PWA. The remote Machine's OS is not this field. Server billing events do not gain a viewer shell. Update any Statsig gate or experiment that still targets the previous `web` or `desktop` value. Historical events keep those old values.
Public authentication pages and startup before
account status arrives use the SDK's anonymous stable ID. Team and Machine
switches do not create a new analytics client. Events include `team_id`,
`team_role`, and `current_plan` for the selected Team. Plan context starts as
`unknown` and refreshes from authoritative billing data on selection, window
focus, and billing-page load. Shared response sequencing rejects older requests.
Joining a Team omits these event metadata fields because an invite token does
not reveal the target Team before acceptance; use account-based join metrics.
Creating a Team records `team_created` after that Team replaces the analytics
identity, so the event carries the created Team rather than the Team selected
when the request started. Its plan stays `unknown` until billing loads. The
event is omitted when the account that started creation has signed out or been
replaced before the request returns.

DeskFleet custom-event metadata carries only the fields listed below. It does
not include account names/email, prompts, Session titles, file paths, provider
configuration, raw RPC parameters, URL queries, or route resource IDs. The SDK
associates events with the user identity described above, including its email.
Automatic page URL metadata is disabled. Auto Capture and Session Replay plugins
are not installed.

Checkout request IDs connect frontend attempts to the server's created-checkout
event. Billing events also retain opaque invoice/event identifiers for
deduplication. These identifiers are not payment credentials.

The core SDK still manages its normal device/session identifiers, SDK metadata,
local evaluation cache, and diagnostics. Its exception reporting can include
stack traces and script URLs; the custom-event field policy does not disable
these SDK diagnostics.

| Event | When | Metadata |
| --- | --- | --- |
| `app_opened` | Main UI or authentication root mounts | `surface`: `app` or `authentication` |
| `page_viewed` | Successful named route navigation, including initial load; authentication root mounts | `page`: route name or `authentication` |
| `account_registered` | The first accepted password registration request; a resend is not another registration | `method`: `password` |
| `account_verified` | Email verification succeeds and creates the session | None |
| `account_signed_in` | Password or passkey sign-in succeeds | `method`: `password` or `passkey` |
| `team_created` | Team creation succeeds | None |
| `team_joined` | Invite acceptance | `outcome`: `attempt`, `success`, or `failure`; no invite token |
| `member_invited` | Invitation | `outcome`; `invited_role`: `admin` or `member`; no email |
| `machine_enrolled` | Local or headless enrollment succeeds | `kind`: `local` or `headless` |
| `workspace_created` | Workspace creation returns successfully | `directory_count` |
| `session_action` | Session create, fork, archive, or restore | `action`; `outcome` for create, fork, and restore; `context` and `scope` when known; `provider` slug on create success |
| `input_submitted` | Backlog or steer input | `outcome`; `delivery`: `backlog` or `steer` |
| `terminal_created` | Terminal creation succeeds | `scope`: `machine` or `worktree` |
| `schedule_action` | Schedule create, accepted manual run, or delete | `action`: `create`, `run`, or `delete` |

GitHub and Google registration and sign-in finish on the server callback. The client does not observe that completion, so those methods are not emitted. Starting an OAuth redirect is not a success. Verification also creates a session and does not also emit `account_signed_in`. Failed sign-in and failed enrollment are not product events.

`attempt`, `success`, and `failure` are recorded only for allowance or admission: Session create, fork, and restore; input submit; invitation; Team join; checkout; and Portal. Archive is success-only. A provider value is only the agent implementation slug on a successful Session create. A terminal records `worktree` when the dial names a Worktree and `machine` otherwise, including a machine terminal opened in a Workspace directory. Schedule update and enablement changes are not events.

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
| `billing_entry_clicked` | Navigation intent; `source=sidebar`/`team_menu`; sidebar also supplies effective plan (when loaded) and action. Join by Team with Plans views, checkout attempts, and verified initial invoice payments; clicks are not purchases. |
| `billing_plans_viewed` | Once per mounted Plans view after loading; effective plan, billing permission, payment/subscription/contact availability |
| `billing_checkout` | Checkout attempt; `outcome`: `started` or `failed`; `target_plan`, `interval`, `request_id`; allowlisted `reason` on failure, never exception text |
| `billing_portal` | Billing management or payment recovery; `outcome`: `started` or `failed`; `source=manage`/`payment_recovery`; allowlisted `reason` on failure |
| `billing_payment_recovery_viewed` | Once per payment-problem status per view for the Team owner; `past_due`, `unpaid`, or `incomplete` |
| `billing_returned` | Allowlisted `checkout_success`, `checkout_cancel`, or `portal` return marker for an accessible Team; navigation only |
| `billing_enterprise_contact_clicked` | Contact-link intent; no mailbox/address is sent |

`billing_checkout` `started` joins `request_id` to server `billing_checkout_created`. The client does not emit an opened event. Server `billing_checkout_created` and `billing_portal_opened` are the API-success facts. Month/year and Go/Pro attempts retain separate request IDs. A retry of an uncertain attempt reuses its ID; count distinct `request_id` for unique Checkout intents. A failure is omitted when the account or selected Team changed before the attempt returned. Leaving the Plans view does not add a client completion event.

The billing server accepts these optional **runtime** settings:

| Variable | Meaning |
| --- | --- |
| `DESKFLEET_STATSIG_SERVER_KEY` | Statsig server secret key for event delivery; keep out of all frontend/Vite variables |
| `DESKFLEET_STATSIG_ENVIRONMENT` | Tier for server events, default `production`; match the frontend tier |
| `DESKFLEET_GA_MEASUREMENT_ID` | Optional GA4 Measurement ID (`G-XXXX`) for server-side `purchase` conversion delivery |
| `DESKFLEET_GA_API_SECRET` | Optional GA4 Measurement Protocol API secret; keep out of all frontend/Vite variables |

Without at least one configured destination (`DESKFLEET_STATSIG_SERVER_KEY` or
both `DESKFLEET_GA_MEASUREMENT_ID` and `DESKFLEET_GA_API_SECRET`), or when
`cp_site_settings.telemetry_enabled` is `false`, no billing analytics requests
are sent. When a `billing_invoice_paid` event with
`billing_reason = "subscription_create"` is delivered and the actor has a stored
`cp_user_marketing_attribution` row, the worker also sends a GA4 Measurement
Protocol `purchase` event carrying the stored `client_id`, `user_id`,
`transaction_id` (`invoice_id`), decimal `value`, `currency`, and first-touch
campaign attribution parameters. No key is committed. Enable the frontend and server keys for the
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
with their corresponding events. Each event batch uses one atomic insert,
with a consistent event-ID order and first-occurrence deduplication.
An independent leased worker delivers up to 25 due events
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
| `session_action` | Create, fork, and restore with `attempt`/`success`/`failure`; archive success only. Context and scope when known. Submission of input is `input_submitted` and is not a consumed provider turn |
| `member_invited` | Invitation attempt/success/failure and invited role; no email. Creating an invitation does not consume a member seat |
| `team_joined` | Invite acceptance attempt/success/failure; no invite token; acceptance is the member-capacity boundary |
| `session_turn_allowance_viewed` | `near_limit`/`reached`/`blocked`, consumed-turn count including inheritance, and finite limit when known |
| `session_turn_plans_clicked` | Upgrade entry from a near-limit or reached turn allowance |
| `peer_connection` | One agent, terminal, desktop, files, ports, or mux attempt, emitted once when it connects or fails. `relay` is `allowed`, `unconfigured`, `free_plan`, `turn_quota_exhausted`, or `metering_unavailable`. `outcome` is `connected` or `failed` |

Turn-warning impressions are deduplicated for the same account, Team, Machine,
Session, and warning boundary across route remounts. Functional failure events
describe failed client attempts: the existing transports do not expose a
specific structured capacity code, so analytics does not infer one from error
messages. Invitation creation does not consume a member seat.
An admission pause is `reached` only for the daemon's explicit
`turn_limit_reached` code. Other pauses are `blocked` and show retry guidance
without an upgrade entry, even if the client's last billing snapshot shows no
remaining turns. Async functional outcomes are omitted when the account or
selected Team has changed.

`observePeerGrant` emits `peer_connection` once when that attempt connects or fails. A repeated connect or fail does not emit again. Closing, revocation, expiry, and account changes that happen before a result leave no event. Relay access is permitted fallback, not the selected ICE path or transferred bytes. Billing's server-side TURN collector remains authoritative for usage. Cancellation, account changes, revocation, and expiry are not connection failures. Desktop file/port peers forward typed observations from main through the existing narrow bridge; the renderer owns Statsig. Internal target-Team correlation drops late events after Team navigation instead of assigning them to the new Team.

## Retired client names

Historical Statsig data still contains these names. Dashboards use the current catalog; events are not backfilled.

`session_created`, `session_forked`, `session_archived`, `session_restored`, `session_capacity_action`, `input_submit_action`, `team_join_action`, `member_invite_action`, `billing_entry_viewed`, `billing_interval_selected`, `billing_checkout_started`, `billing_checkout_opened`, `billing_checkout_failed`, `billing_portal_started`, `billing_portal_opened_client`, `billing_portal_failed`, `peer_granted`.

The sidebar click is the billing-entry intent. The checkout interval is stored on `billing_checkout`.

## Not collected

Do not add events for settings, appearance, notifications, GitHub connection, MCP server edits, permission prompts, file browsing, search queries, composer keystrokes, model selection, session rename, or the AI-usage page. Search, remote desktop, and machine control remain visible through `page_viewed`. Connectivity remains visible through `peer_connection`. A grant that never reaches connected or failed is not an event.

## Metrics

Define these in Statsig from the current names. Do not add an event to stand in for a metric filter.

- Activation rate from `account_verified` to `machine_enrolled`, `workspace_created`, `session_action` create success, and `input_submitted` success.
- Weekly active accounts with `app_opened`, `terminal_created`, or `input_submitted` success, split by `custom.platform`.
- Allowance path from `session_turn_allowance_viewed` through `session_turn_plans_clicked` and `billing_checkout` started to `billing_invoice_paid` where `billing_reason` is `subscription_create`.
- Invite and join success counts.
- `peer_connection` failure rate, split by `feature` and `relay`.
- Subscription lifecycle counts from the server billing events.

## Feature gates and experiments

Feature gates control frontend rollout through the shared analytics helpers.

Search is always available in Web and Electron, including builds without Statsig.
Search requests require a selected Team and retain server-side Team authorization.

| Gate | Controls | Default |
| --- | --- | --- |
| `native_presentor` | Native desktop window entry and new launches on Linux, Windows, and macOS | Off |

Keep `native_presentor` at 0% rollout except for explicitly targeted testers
while the native viewer is validated over several future versions. The native
window action requires both this gate and the Electron host capability. Missing
configuration, an unavailable evaluation, pending identity evaluation, or a gate
that does not pass hides the action; the click handler also checks its current
value before launching. Closing the gate prevents new windows without closing
already running viewers. The embedded browser viewer remains available. This
rollout gate does not replace the existing Team peer grants or desktop control
authorization.

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
permit the three Statsig origins in addition to the existing development
HMR policy: `https://featureassets.org`, `https://prodregistryv2.org`, and
`https://statsigapi.net` (SDK exceptions). When a Google Tag (`VITE_GTM_ID`,
`VITE_GA_MEASUREMENT_ID`, or `VITE_GOOGLE_ADS_ID`) is configured at build time,
`buildRendererCsp` also permits the explicit Google Tag origins (`googletagmanager.com`,
`google-analytics.com`, `analytics.google.com`, `googleadservices.com`, and
`doubleclick.net`) in `script-src`, `connect-src`, and `img-src`. Optional
[Sentry error reporting](error-reporting.md) adds its configured DSN origin.
Without any configured integration, production keeps `connect-src 'none'`. A Web host
that supplies its own CSP must allow these origins alongside the application's
API/peer requirements.

Focused tests cover disabled configuration, identity replacement and logout,
initialization failure, reactive/default evaluations, route metadata, root
teardown, action success/failure payloads, payment funnel attribution, peer
outcomes, and Electron CSP. Server HTTP fixtures and PostgreSQL tests cover
verified invoice facts, replay deduplication, immutable delivery retries, and
lease/transaction behavior. To verify a real
Statsig project, build with its client key, perform a listed action, and inspect
the event in Statsig. No project key is committed to this repository.

SDK reference: [Statsig JavaScript client](https://docs.statsig.com/client/javascript-sdk).
