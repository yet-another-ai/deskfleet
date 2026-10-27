# Identity, subscriptions, and usage requirements

Status: agreed product direction and implementation specification, prepared on
2026-10-27. This document does not claim these capabilities are implemented.
The current server still uses OIDC and displays unlimited usage allowances.
Items marked **proposed** or listed under **Open decisions** need resolution
before the affected behavior ships.

This document owns account and commercial requirements. [Architecture](architecture.md)
owns component boundaries; [Agent Sessions](agent-sessions.md) owns execution,
fork, and archive semantics; [backend scope](backend.md) tracks delivery.

## Agreed scope

- Replace OIDC with deskfleet-owned accounts, public registration, email/password
  login, and Passkeys. Web and Electron use the same account authority.
- Subscriptions and usage belong to a Team. A person can use a single-member
  Team; membership in several Teams does not combine their plans.
- Sell platform subscriptions. AI credentials and execution remain on user
  machines. AI token resale, credit purchases, and wallets are outside this release.
- Offer Free, Go, Pro, and manually assigned Enterprise on the hosted service.
  Go and Pro differ only in monthly TURN allowance.
- Self-hosted installations use the same account system, unlimited product
  allowances, and no payment integration. Operators supply their own TURN when
  needed. Self-hosting is a deployment setting, not a hosted client's plan choice.
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
21,474,836,480 bytes per period. Compare integer bytes; round only for display.
Prices, currency, and sale intervals are not yet selected.

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

deskfleet owns email verification. Invitation acceptance still requires a
verified email matching the invitation. Stable user IDs identify membership and
resource ownership across email changes. Registration, login, email changes, and
invitations need one consistent email matching/uniqueness policy.

An unverified registration cannot access Team resources, accept invitations,
enroll Machines, or purchase a subscription. Verification and recovery remain
available so the user can complete account setup.

Public registration and Team creation are separate site policies. Site Admin
grants remain explicit operator actions on an existing account; the first user
or a special email address does not automatically receive that authority.

Account closure must preserve the final-Team-administrator invariant and resolve
machine ownership and billing responsibilities. Closure and retention policy are
open decisions, not an implicit cascading deletion.

### Security and clients

- Use a maintained Argon2id implementation for passwords. Bound hashing
  concurrency and run it outside the async request executor. Set password and
  common-password screening policies before release.
- Passkey ceremonies use server-side, expiring, single-use challenge state.
  Validate RP ID, allowed origins, and user verification. Store public credential
  material, not private keys.
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
- **Proposed Web transport:** Secure, HttpOnly cookies with CSRF protection and
  WebSocket Origin validation. Current Web uses sessionStorage bearer tokens.
  Resolve Web/API origin layouts and cross-site hosting before changing transport.
- Site administration remains separate from Team data access. Ordinary logout
  does not automatically cancel scheduled work; account disablement must be
  checked when authorizing its next execution.

Mail delivery, application origins, WebAuthn configuration, and payment secrets
are deployment configuration. Failed mail delivery must remain diagnosable and
retryable without permanently stranding the account.

## Subscription ownership and lifecycle

### Billing authority

The Team owns its billing profile and provider customer/subscription mappings.
Changing a payment contact or removing the purchaser does not transfer or erase
the subscription.

**Proposed permission mapping:** Team administrators manage purchases, plan
changes, cancellation, payment methods, and invoices. Members see the effective
plan and usage. Delegated Agent/MCP credentials cannot perform billing changes.
A separate billing role has not been requested.

### Monthly usage periods

TURN periods are calendar months anchored to the subscription's effective date,
not fixed-duration day counts or the first of every calendar month.

**Proposed month-end convention:** when the original day is absent, use that
month's last day and retain the original anchor for later months. A January 31
anchor would reset on February 28 in 2027, then March 31 and April 30.

Store explicit period start/end instants and assign usage to `[start, end)`.
A new period starts with zero usage. Login, reconnection, and duplicate payment
notifications never reset usage. Timezone and boundary time remain open; UTC
with the original subscription time is the proposed convention.

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
- Plan-change timing, proration, reactivation, and refund/dispute treatment remain
  open decisions; do not silently adopt payment-provider defaults.

**Proposed over-limit fallback:** preserve existing members, Sessions, files, and
history after a smaller allowance takes effect. Block growth while the relevant
count is at or above its limit, and apply Free turn limits to subsequent starts.
Allow reading, archiving, member removal, and billing recovery. Do not remove
members or archive Sessions automatically.

### Enterprise override

Only a current Site Admin can grant/revoke Enterprise for a hosted Team.
Enterprise unlocks every product allowance, including TURN. It is not sold via
Checkout or selectable by Team administrators.

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

**Proposed consumption definition:**

- Queued inputs, tools, permission decisions, and steering injected into the
  current turn do not consume another turn.
- A prompt, idle steer, or `promptRequired` fallback consumes one when a new
  execution is dispatched to the provider.
- Confirmed failures before dispatch consume none. Once dispatch begins,
  cancelled/interrupted attempts and uncertain delivery consume one. Idempotent
  request retries never double-count; explicit new attempts are evaluated again.

Failure accounting needs confirmation. Current code creates a turn record before
preparing attachments/contacting the provider, so a count of all turn rows is
not equivalent to this proposed definition.

The owning daemon checks/commits consumption at its shared new-turn boundary,
covering interactive input, backlog, steering fallback, and scheduled inputs.
It obtains entitlements from central authority, never client plan fields. Each
Session has one owning daemon, so a cross-machine turn allocator is unnecessary.

An accepted 30th turn can finish. Further starts pause with an explicit limit
reason; preserve pending inputs for withdrawal or later execution after upgrade.
Automatic backlog resumption after upgrade remains an open UX decision. A plan
update cannot fabricate or duplicate a submission.

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

**Proposed meter:** retain the current sum of TURN sent bytes across client-facing
and peer-facing sockets, attributed to the Team on the saved peer grant. Do not
add received bytes to this sum. It measures relay protocol traffic, not file
payload size. Final metering semantics remain an open decision.

Current coturn Redis Pub/Sub collection cannot replay missing events and
accumulates each notification independently. Production quota collection needs
defined collector ownership, prevention of duplicate ingestion, period aggregation,
and reporting of gaps/freshness. Do not promise exact accounting or treat missing
events as proof of zero usage. Recovery of every lost byte is not an agreed
first-release requirement.

Continue recording during Enterprise. Whether this traffic consumes the restored
paid allowance after revocation remains open. Do not silently clear usage or
move the period anchor on plan changes before that policy is defined.

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
configuration; no second payment provider or credit-wallet integration is included.

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
- Team Plans & Usage: effective plan, usage/limits, period and next reset,
  remaining TURN, and actionable restriction reasons. Unlimited and unavailable
  are distinct from numeric zero.
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
8. With the proposed month-end convention, January 31 anchors clamp in February
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

## Open decisions

| Decision | Proposed default or clarification |
| --- | --- |
| Offers | Go/Pro price, currency, and monthly-only versus other sale intervals. No paid trial has been selected. |
| Plan changes | Effective dates and proration. Proposed: paid upgrades after payment confirmation; downgrades at period end. |
| Usage continuity | Proposed: retain usage/anchor on in-period changes; Go with 1.5 GiB used becomes Pro with 18.5 GiB remaining. Define reactivation and Enterprise-period accounting. |
| Period boundaries | Confirm month-end clamping while preserving the original day. Choose timezone/time-of-day; UTC with the original subscription time is proposed. |
| Free fallback with excess | Confirm preserving resources and blocking growth as described above. |
| Turn consumption | Confirm unsent failures, cancellation/interruption/uncertain delivery, and backlog resumption after upgrade. |
| TURN meter | Confirm byte accounting and behavior during stale/unavailable collection; keep the agreed new-authorization/existing-access distinction. |
| Account security | Set password/session/challenge policies, recent-authentication methods/window, and whether password recovery retains Passkeys. |
| Account closure | Define closure, resource/billing handoff, and retention instead of cascading Team deletion. |
| Deployment/payments | Resolve cookie/origin support; Stripe subscriptions are selected. Define refunds/disputes and Team-closure billing before live sales. |

## Delivery boundaries

1. Implement accounts and clients. Remove OIDC dependencies/routes/config, Dex
   infrastructure, and OIDC fixtures/smoke assumptions; replace with real owned
   authentication tests. Rebuild development databases and re-enroll Machines
   without reusing old credentials.
2. Implement effective entitlements, Team admission, per-Session turn limits and
   fork inheritance, monthly TURN authorization, and usage display.
3. Integrate payment coverage/expiry, reconciliation, Enterprise administration,
   and agreed plan changes. Verify concurrency and failure at central-store,
   daemon, and real-client boundaries.
4. Update server, environment, CI, and self-hosting guides with implementation.
   Until then, their OIDC setup describes current code, not this target design.
