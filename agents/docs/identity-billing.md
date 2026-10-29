# Identity, subscriptions, and usage requirements

Status: implemented product contract, updated 2026-10-28. The first payment
integration is Stripe subscriptions. Prices and currency are operator-configured;
no live payment credentials are stored in the repository.

This document owns account and commercial requirements. [Architecture](architecture.md)
owns component boundaries; [Agent Sessions](agent-sessions.md) owns execution,
fork, and archive semantics; [backend scope](backend.md) tracks delivery.

## Agreed scope

- Replace OIDC with DeskFleet-owned accounts, public registration, email/password
  login, and Passkeys. Web and Electron use the same account authority.
- Subscriptions and usage belong to a Team. A person can use a single-member
  Team; membership in several Teams does not combine their plans.
- Sell platform subscriptions. AI credentials and execution remain on user
  machines. AI token resale, credit purchases, and DeskFleet-managed wallets are
  outside this release; Stripe may apply native invoice credits from proration.
- Offer Free, Go, Pro, and Enterprise on the hosted service. Go and Pro differ
  only in monthly TURN allowance and are sold as monthly or yearly Stripe
  subscriptions. Enterprise remains a Site Admin grant; Plans & Usage can also
  show a configurable Contact us mailbox (`DESKFLEET_ENTERPRISE_CONTACT_EMAIL`)
  when operators want inbound sales mail.
- Self-hosted installations use the same account system, unlimited product
  allowances, and no payment integration. Operators supply their own TURN when
  needed. Self-hosting is a deployment setting, not a hosted client's plan choice.
  Self-hosters may still set the Enterprise contact mailbox for their own UI.
- Existing databases contain development data and can be rebuilt during
  implementation. No legacy account linking, OIDC account/data migration, or
  compatibility with the previous provisional schema is required.
- Preserve Team -> Machine -> Workspace -> Session-owned Worktree ownership,
  the Rust/Actix server, and the TypeScript daemon. Keep `PROTOCOL_VERSION = 1`.

## Plan matrix

| Allowance | Free | Go | Pro | Enterprise | Self-hosted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unarchived Agent Sessions per Team | 3 | Unlimited | Unlimited | Unlimited | Unlimited |
| Consumed turns per Agent Session, including inherited usage | 30 | Unlimited | Unlimited | Unlimited | Unlimited |
| Joined Team members, including administrators | 3 | Unlimited | Unlimited | Unlimited | Unlimited |
| TURN relay allowance | Unavailable | 2 GiB/month | 20 GiB/month | Unlimited | Unlimited on operator-configured TURN |
| Assignment | Default | Paid subscription | Paid subscription | Site Admin only | Deployment configuration |

One GiB is 1,073,741,824 bytes. Go allows 2,147,483,648 bytes and Pro allows
21,474,836,480 bytes per monthly usage period. Compare integer bytes; round only
for display. Checkout sells monthly and yearly recurring Prices for Go and Pro.
TURN usage periods remain calendar months anchored to the subscription even when
the Stripe billing interval is yearly. Prices and currency come from the four
configured Stripe Prices. No paid trial or DeskFleet-managed wallet is offered.

Free has the four restrictions above; no additional feature exclusions have been
selected. Direct connectivity remains available. Plans never confer Team
membership, resource access, or Site Admin authority.

## Accounts and authentication

### Required account flows

1. Register with email/password and prove mailbox control. Verification delivery
   can be retried. Credentials supplied by an unverified third party must not be
   attached to a later verified owner.
2. Log in with email/password or a registered Passkey. Both produce the same
   application-session identity and Team authority.
3. Recover a password using an expiring, single-use email link. Unknown and
   registered addresses receive the same public response.
4. Change a password or email. Verify a new address before replacing the current
   verified address, and notify the previous address.
5. Register, name, list, and remove multiple Passkeys. Require recent
   authentication for security-sensitive changes, including adding credentials.
6. Inspect login sessions and revoke the current session, another session, or
   all sessions. Login devices are distinct from enrolled Machines.
7. Support account disablement, revoking existing login sessions/peer access and
   preventing new sessions and authorization of later delegated work.

DeskFleet owns email verification. Invitation acceptance still requires a
verified email matching the invitation. Stable user IDs identify membership and
resource ownership across email changes. Registration, login, email changes, and
invitations need one consistent email matching/uniqueness policy.

An unverified registration cannot access Team resources, accept invitations,
enroll Machines, or purchase a subscription. Verification and recovery remain
available so the user can complete account setup.

Public registration and Team creation are separate site policies. Site Admin
grants remain explicit operator actions on an existing account; the first user
or a special email address does not automatically receive that authority.

Site administrators may configure Terms of Service and Privacy Terms URLs
independently in runtime site settings. When either is present, registration
requires an initially unchecked agreement checkbox with links to the configured
documents. The server checks acceptance before sending the verification link,
including resends. With both URLs empty, registration has no agreement checkbox
or acceptance requirement. Password recovery remains available without it.

Account closure must preserve the final-Team-administrator invariant and resolve
machine ownership and billing responsibilities. Closure and retention policy are
open decisions, not an implicit cascading deletion.

### Security and clients

- Use a maintained Argon2id implementation for passwords. Bound hashing
  concurrency and run it outside the async request executor. Passwords contain
  15–128 characters, with a small local denylist and repeated-character rejection.
  Login sessions last 30 days; recent authentication lasts 10 minutes. Mail links
  expire after one hour and Passkey ceremonies after five minutes. Recovery
  retains Passkeys and revokes all login sessions and peer grants.
- Passkey ceremonies use server-side, expiring, single-use challenge state.
  Validate RP ID, allowed origins, and user verification. Store public credential
  material, not private keys.
  Public login options use discoverable credentials and expose the same options
  for every email, without credential IDs or account-existence signals. New
  registrations require resident credentials. Earlier nonresident development
  keys still work for authenticated reauthentication; use password login to
  register a discoverable replacement for public Passkey login.
- Rate-limit authentication, registration, recovery, and mail sending. Secrets
  must not enter logs, history, analytics, or client-visible errors.
- Retain opaque application sessions with hashed tokens in central storage.
  Credential recovery invalidates affected login sessions and peer grants, then
  notifies clients/daemons. Persist revocation before sending notifications.
- Machine credentials remain separate. Logout and password reset do not remove
  registrations, delete files, or stop accepted work.
- Electron uses the system browser and the existing short-lived, one-use
  code/verifier exchange. Keep credentials in the main process and secure
  platform storage, outside the renderer.
- Web uses Secure, HttpOnly, SameSite=Lax cookies (Secure is disabled for local
  HTTP development), CSRF tokens, and WebSocket Origin validation. Serve Web/API
  on the same site with explicit allowed origins; unrelated cross-site origins
  are unsupported. The server address is configured at build time and is not
  retained as a browser preference.
- Site administration remains separate from Team data access. Ordinary logout
  does not automatically cancel scheduled work; account disablement must be
  checked when authorizing its next execution.

Credential recovery and email changes lock the account before consuming its
proof. Registration claims the unique mailbox before consuming registration
proofs, then rechecks expiry and one-time use in the same transaction. Peer grants
lock account and Team parents before revocable membership/login records;
invitation acceptance locks its Team before the invitation. These orders match
revocation and deletion, preventing opposite parent/child lock acquisition.

Identity lookup and revocation indexes follow account, Team, and expiry filters.
Site account search uses indexed character grams, followed by the original
literal substring check, including short queries, punctuation, and Unicode.
Expired rate windows, login attempts/codes, challenges, and invitations are
removed by shared background maintenance in bounded batches. Authentication
still checks expiry when consuming a credential; deletion timing does not extend
its validity.

Mail delivery, application origins, WebAuthn configuration, and payment secrets
are deployment configuration. Failed mail delivery must remain diagnosable and
retryable without permanently stranding the account.

## Subscription ownership and lifecycle

### Billing authority

The Team owns its billing profile and provider customer/subscription mappings.
Changing a payment contact or removing the purchaser does not transfer or erase
the subscription.

**Permission mapping:** Team administrators manage purchases, plan
changes, cancellation, payment methods, and invoices. Members see the effective
plan and usage. Delegated Agent/MCP credentials cannot perform billing changes.
A separate billing role has not been requested.

### Monthly usage periods

TURN periods are calendar months anchored to the subscription's effective date,
not fixed-duration day counts or the first of every calendar month.

**Month-end convention:** when the original day is absent, use that
month's last day and retain the original anchor for later months. A January 31
anchor would reset on February 28 in 2027, then March 31 and April 30.

Store explicit period start/end instants and assign usage to `[start, end)`.
A new period starts with zero usage. Login, reconnection, and duplicate payment
notifications never reset usage. Boundaries use UTC
and retain the original subscription time of day.

The stored usage anchor remains stable for the same subscription. Stripe flexible
billing also retains its billing-cycle anchor when a customer switches between
monthly and yearly billing. Paid coverage follows the subscription item's period;
DeskFleet's monthly usage boundaries and accumulated bytes remain unchanged.
A replacement subscription adopts its own anchor.

### Payment coverage and expiry

- First activation and renewal require server-verified payment/subscription
  state. A browser return URL never grants paid access.
- There is **no payment grace period**. At the end of verified paid coverage,
  unrenewed Go/Pro entitlements end immediately. The hosted Team becomes Free
  unless Enterprise is assigned.
- Cancelling automatic renewal preserves already-paid coverage until its end.
- Expiry follows the stored coverage deadline, not arrival of a failure webhook.
  Reconciliation may restore access after delayed payment verification; an
  unverified checkout or renewal cannot extend coverage.
- Accepted work and issued relay access retain the lifetimes specified below.
  This continuation is not a billing grace period.
- One Stripe Portal configuration offers Go and Pro as separate Products, each
  with monthly and yearly Prices. Plan and interval changes apply immediately
  with Stripe's native proration and an immediate invoice. DeskFleet applies the
  selected plan only after verifying its paid invoice, including a zero-total
  invoice settled by credits. A failed upgrade retains the previous verified
  plan and coverage. Cancellation remains effective at period end. Usage is
  preserved within the existing monthly period. Refunds/disputes are
  operator-managed; Stripe's invoice credits do not introduce a DeskFleet wallet
  or automatic refund workflow.

**Over-limit fallback:** preserve existing members, Sessions, files, and
history after a smaller allowance takes effect. Block growth while the relevant
count is at or above its limit, and apply Free turn limits to subsequent starts.
Allow reading, archiving, member removal, and billing recovery. Do not remove
members or archive Sessions automatically.

### Enterprise override

Only a current Site Admin can grant/revoke Enterprise for a hosted Team.
Enterprise unlocks every product allowance, including TURN. It is not sold via
Checkout or selectable by Team administrators. When
`DESKFLEET_ENTERPRISE_CONTACT_EMAIL` is set, Plans & Usage shows a Contact us
mailto action for Teams that are not already on Enterprise; when unset, that
offer is omitted.

Store the manual grant separately from the underlying subscription. Effective
hosted-plan precedence is Enterprise, then an eligible Go/Pro subscription, then
Free. Payment events cannot overwrite Enterprise. Revocation restores the
still-valid paid plan or Free if none is valid.

Assignment does not cancel, pause, or refund a paid subscription; it continues
its billing lifecycle. Show that effect to the administrator. Record actor,
Team, previous/new state, and time atomically with each grant/revocation. This
authority does not confer access to Team machines or conversations.

## Usage and enforcement

### Team members

All joined members, including administrators, occupy seats; pending invitations
do not. Accepting an invitation atomically checks capacity and inserts membership.
Concurrent acceptances cannot exceed the limit, and retries cannot consume a
second seat for an existing member.

### Unarchived Sessions

Count unarchived Agent Sessions across enrolled Team Machines, independently of
provider execution or connected clients. Idle Sessions and offline Machines
still count. Archived Sessions and Sessions on removed Machines do not count.
TerminalSessions are not Agent Sessions.

Create, fork, and restore require capacity. Archive releases capacity only after
the daemon closes associated resources and durably commits `archived`.
An `archiving` or retained `provision_failed` Session still occupies capacity.
Restore preserves consumed-turn history.

Central PostgreSQL owns atomic Team capacity admission. Every daemon lifecycle
entry point, including scheduled creation, uses that admission. Async replica
counts serve display/reconciliation, not concurrent hard limits. Admissions bind
Machine, operation, and target and are idempotent. Unknown outcomes retain
capacity until the daemon confirms the outcome; timeout alone cannot release a
possibly committed Session. Release/restore acknowledgements must not apply to
a later lifecycle generation.

### Per-Session turns and fork inheritance

Free permits at most 30 consumed turns over the Session lifetime. Archive,
restore, process restart, and reconnect do not reset usage. Unlimited plans also
record consumption so later Free fallback has an accurate count.

Fork inherits the source's consumed-turn total at the captured fork boundary.
Persist an immutable inherited baseline:

`consumed turns = inherited baseline + turns consumed by this Session`

Later parent activity does not change that baseline. Further forks inherit the
full total, including inherited usage. A source at 24 leaves its child with
6 Free turns; a source at 30 leaves none. Inherited display history must not
become executable input or synthetic local turn records.

**Consumption definition:**

- Queued inputs, tools, permission decisions, and steering injected into the
  current turn do not consume another turn.
- A prompt, idle steer, or `promptRequired` fallback consumes one when a new
  execution is dispatched to the provider.
- Confirmed failures before dispatch consume none. Once dispatch begins,
  cancelled/interrupted attempts and uncertain delivery consume one. Idempotent
  request retries never double-count; explicit new attempts are evaluated again.

A turn record alone does not count. The daemon persists its monotonic `consumed`
marker immediately before dispatch, after attachment preparation and a fresh
central entitlement lookup. Authority failure pauses new dispatch; accepted
provider work can finish.

The owning daemon checks/commits consumption at its shared new-turn boundary,
covering interactive input, backlog, steering fallback, and scheduled inputs.
It obtains entitlements from central authority, never client plan fields. Each
Session has one owning daemon, so a cross-machine turn allocator is unnecessary.

An accepted 30th turn can finish. Further starts pause with an explicit limit
reason; preserve pending inputs for withdrawal or later execution after upgrade.
After upgrading or restoring connectivity, users explicitly retry the preserved
input. Plan changes never automatically resume queued execution.

### TURN relay allowance

Free receives no TURN credentials. Direct connectivity and configured STUN stay
available. Explain the plan restriction when direct connection fails, rather
than reporting a reachable Machine as offline.

For Go/Pro, compare current-period usage when granting new relay authorization.
At or above the limit, omit TURN while retaining direct connectivity. Both
endpoints receive a consistent decision; offer/negotiation paths cannot issue
credentials for a denied grant. Enterprise and self-hosted TURN are unlimited.

Issued authorizations and existing connections retain their original bounded
lifetime after exhaustion or paid expiry; reconnect does not extend it. Actual
usage may exceed the allowance. This is an admission threshold, not a hard byte
cutoff. This release includes no automatic overage charge.

**Meter:** retain the current sum of TURN sent bytes across client-facing
and peer-facing sockets, attributed to the Team on the saved peer grant. Do not
add received bytes to this sum. It measures relay protocol traffic, not file
payload size. Period totals remain exact decimal integer strings in the API.

PostgreSQL retains raw deltas and maintains Team/minute sent-byte aggregates in
the same transaction through an insert trigger. Migration backfills existing
events while excluding concurrent writes. Full minutes use these aggregates;
each partial boundary reads only its raw timestamp range. This preserves exact
millisecond anchors, short intervals, month-end boundaries, and late deltas
without repeatedly summing every event in the billing month. Aggregate totals
use PostgreSQL numeric values so summed bytes can exceed a single bigint.

Current coturn Redis Pub/Sub collection cannot replay missing events and
accumulates each notification independently. Production quota collection needs
defined collector ownership, prevention of duplicate ingestion, period aggregation,
and reporting of gaps/freshness. Do not promise exact accounting or treat missing
events as proof of zero usage. Recovery of every lost byte is not an agreed
first-release requirement.

Continue recording during Enterprise. Revoking the override retains the period
and usage, so Enterprise-period traffic consumes any restored paid allowance.
The collector has a database lease and reports freshness/gaps; stale collection
denies new metered Go/Pro relay grants. Enterprise and self-hosted grants remain
unlimited. Redis Pub/Sub loss is still not reconstructable.

### Effective policy and accepted work

Check resource authorization before entitlements; unlimited never bypasses
membership or action permission. The daemon evaluates trusted effective limits
on each new turn. An old peer cannot retain unlimited paid turn authority past
paid coverage. Cached decisions need explicit validity and refresh/fallback
semantics; paid expiry cannot wait for peer reconnection.

Accepted turns, shells, and relay access retain their lifetimes. New resource
admission requires central availability under the existing architecture.
Entitlement propagation and Enterprise revocation during control disconnection
need an explicit implementation contract, without an unbounded offline cache
of paid authority.

## Payment integration and data

The first implementation uses Stripe subscriptions exclusively, with Checkout
and Customer Portal. The Rust server owns the integration; daemons and renderers
never hold payment credentials. Prices and Stripe Price IDs are deployment
configuration; no second payment provider or custom wallet is included.

The integration targets Stripe API `2026-09-30.endive`, with the same version for
snapshot webhooks. Checkout explicitly creates flexible subscriptions. Coverage
uses the subscription item's period end and a matching invoice with `status=paid`.
Portal cancellation is represented by Stripe's `cancel_at` timestamp; its
`cancel_at_period_end` boolean remains false for flexible subscriptions.

- A server-controlled offer catalog determines prices and allowances. Clients
  supply Team/offer/request IDs, not authoritative amounts, provider customer
  IDs, entitlements, or return URLs.
- Checkout requests are idempotent and prevent simultaneous payable subscriptions
  for a Team, including completed-but-unsynchronized purchase attempts.
- Verify webhooks before durable event-inbox acceptance. Acknowledge durable
  receipt, then process asynchronously with retries and deduplication.
- Reconcile current provider objects into a local subscription projection.
  Serialize updates per subscription so stale work cannot overwrite new state.
  Supplement webhooks with reconciliation for missed events.
- Ordinary authorization uses local entitlements and coverage deadlines. A
  provider outage neither extends coverage nor invalidates already-paid access.
- Keep credentials, subscriptions, manual grants, admissions, and usage separate.
  Related writes are transactional; never hold transactions across provider or
  daemon network requests.

Logical records include accounts/credentials, verification and recovery
challenges, login sessions, Team billing profiles, paid coverage/period anchors,
Enterprise grants/audit, checkout attempts, payment events, Session admissions,
consumed/inherited turns, and period-attributed TURN usage. Exact table and API
names remain implementation details. Separate microservices are not required.

## User interfaces

- Account: registration, verification/resend, login, recovery, credential and
  login-session management. Electron opens trusted Web authentication and resumes
  after exchange.
- Plans & Usage is its own settings section, available with or without an
  enrolled machine, and shows the selected Team's effective plan, usage/limits,
  period and next reset, remaining TURN, and actionable restriction reasons.
  Unlimited and unavailable are distinct from numeric zero. Team settings keep
  team details, members, and machines separate from subscription management.
- Billing: checkout progress, renewal/cancellation state, payment methods,
  invoices, and recovery actions for authorized administrators.
- Session: consumed/remaining Free turns including inherited usage, capacity
  errors, paused inputs, and archive/upgrade actions.
- Site administration: find the Team metadata needed for Enterprise grants,
  show underlying subscription/continuing charges, and inspect related audit
  without exposing Team execution or conversations.

## Acceptance scenarios

1. Registration proves mailbox control. Invalid, expired, reused, or wrong-purpose
   challenge tokens cannot create authenticated access or modify credentials.
2. Password and Passkey work in Web/Electron with identical Team authority.
   Recovery revokes affected login sessions and peers without deleting Machines
   or stopping accepted execution. Disablement revokes current interactive
   access and rejects later delegated work while preserving Machine registration.
3. Two concurrent invitations cannot fill the last Free seat twice. Concurrent
   Session creation across Machines, including scheduled creation, cannot claim
   the last Free Session slot twice.
4. Full capacity rejects restore/fork. Offline Machines retain capacity; archive
   releases only on completion. Retries do not double-count, and unknown outcomes
   are reconciled before release.
5. A Free Session at 29 starts one more turn. Backlog and steering fallback cannot
   start turn 31. Restart and archive/restore preserve usage.
6. Fork at 24 inherits 24; later parent activity does not alter it. Fork at 30
   receives no fresh Free turns, including after a further fork.
7. Free gets direct connectivity but no relay credentials. Go/Pro enforce exact
   integer-byte limits for new authorization on both endpoints while preserving
   the original lifetime of existing access.
8. With the month-end convention, January 31 anchors clamp in February
   and return to March 31. Boundary assignment and repeated notifications never
   reset or double usage.
9. Unrenewed coverage ends at its deadline without a webhook or grace period.
   Connected peers cannot start unrestricted turns afterwards; accepted turns
   and relay access are not killed.
10. Only Site Admin changes Enterprise; changes are audited and safe to retry.
    Payment events cannot erase it. Revocation returns valid Go/Pro or Free;
    assignment never automatically cancels the underlying subscription.
11. Redirects cannot grant paid access. Duplicated/out-of-order events, failed
    workers, and concurrent synchronization preserve coverage and manual grants.
12. Self-hosted accounts and enrollment work without payment configuration;
    allowances are unlimited and TURN remains operator-configured.

## Deployment and release choices

The implementation uses monthly/yearly Go and Pro Prices under two Stripe
Products and one Portal configuration. Plan and interval changes use immediate
proration and verified paid invoices; cancellation takes effect at period end.
It retains UTC month-end clamping, resource-preserving Free fallback, durable
turn consumption, explicit backlog retry, and usage under Enterprise.
[Stripe operations](stripe.md) documents the exact Portal configuration, webhook,
reconciliation, and test/live setup.

Prices and currency must be selected when creating Stripe offers. Account closure,
Team closure while subscribed, retention, and automated refund/dispute policies
are outside this first release. Existing account disablement and Team resource
permissions remain separate from subscription payment state.

## Delivery and verification

- Owned email/password and Passkey APIs replace OIDC, including real software
  authenticator, cookie/Origin/CSRF, recovery, revocation, and desktop exchange tests.
- Central PostgreSQL transactions reserve Team capacity. Daemons retain unknown
  outcomes and reconcile durable creation, archive, restoration, and deletion.
- Provider dispatch checks fresh Team authority. Fork inheritance and consumed
  markers survive retries, restarts, and plan changes.
- Stripe webhook signatures, durable inboxes, operation leases, verified paid
  invoices, deadlines, Enterprise overrides, and monthly usage have focused tests.
- Web and Electron share account security, plan/usage, and administrative UI.
  Development smoke tests use local verification mail rather than Dex.
- Rebuild disposable central and local development data and re-enroll Machines.
  Old schemas and credentials are intentionally not migrated.
