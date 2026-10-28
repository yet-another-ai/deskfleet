# Backend implementation scope

This document defines the first backend delivery and the local implementation
that it replaces or extends. [Architecture](architecture.md) owns component and
resource boundaries; [Agent Sessions](agent-sessions.md) and
[terminals](terminals.md) own execution and replay semantics. Implementation entry
points are the [server guide](../../apps/server/README.md),
[daemon guide](../../apps/daemon/README.md), and shared Vue packages.

[Identity and billing requirements](identity-billing.md) supersede the original
OIDC-only identity decision and define the implemented account/subscription
contract. Stripe is the first payment provider; [operations](stripe.md) describes
the required offers, Portal, and webhook configuration.
The server now owns verified accounts, password/Passkey authentication, and
browser/native sessions. The implementation preserves the existing resource
ownership and explicit Site Admin boundary.

## Confirmed product decisions

- Prioritize the officially hosted service and replace OIDC with owned accounts,
  public email/password registration, and Passkeys.
- Make Team the subscription boundary. Free limits members, unarchived Sessions,
  and per-Session turns and has no TURN. Go/Pro remove those quantity limits and
  provide distinct monthly TURN allowances. Only Site Admin can assign the
  unlimited Enterprise override. Exact rules are owned by the
  [plan matrix](identity-billing.md#plan-matrix).
- Anchor monthly TURN periods to subscription dates and provide no payment grace
  period. Preserve the original lifetime of already-issued relay access.
- Use the same account system with unlimited allowances and no payments for
  self-hosting. Existing databases are development-only and can be rebuilt;
  no legacy OIDC identity/data migration is required.
- Require login and Team selection before resource creation. Enroll each machine
  into its Team; the automatically created local Team is development scaffolding.
- Members can operate every machine in their Team. Administrators manage members
  and roles and remove machines. Members can enroll their own machines, rename
  Team machines (the name defaults to the hostname), configure
  Providers, create or delete Workspaces, and create, archive, or restore Sessions.
- Use PostgreSQL for the central server and SQLite for each daemon.
- Keep site administration separate from Team roles. Explicit operator commands
  grant or revoke the role for existing users. Site administrators manage
  runtime site settings through the Web-only administration UI without gaining
  access to other Teams or their machines. Web and Electron both display public
  site settings and apply the Team-creation setting.
- Central resource policies use explicit typed actions; Team and Machine list
  scopes enforce membership in SQL. Shared operation boundaries retain these
  checks for HTTP, signaling, and delegated Agent access.
- Deliver an independent Vue Web client alongside Electron. Extract shared UI
  components into a common component package. The Rust server is API-only; Web
  frontend hosting is separate.
- Send Workspace, Provider, and machine-settings management requests to backend
  APIs. The backend authorizes and forwards them to the owning daemon. The daemon
  validates and executes machine-local changes.
- Keep Agent interaction, Git queries, and terminal streams on WebRTC. Working
  established peers can continue working when the central connection is lost.
  Assume the central service is available for the first release; do not add an
  offline resource-creation or offline-authorization subsystem.
- Trust the central service to bind verified user/machine identities to SDP
  fingerprints; endpoints use standard WebRTC DTLS key exchange. Peer access
  lasts until closure, explicit revocation, or a 24-hour expiry, whichever is
  first. Signaling reconnection does not extend the grant. See
  [WebRTC key exchange](webrtc-security.md) for the handshake and lifecycle.
- Synchronize Agent conversations, tool history, and audit. Keep terminal output
  on the executing machine and desktop media transient.
- Archive is the normal Session completion action. It closes the provider and
  Session-owned terminals without deleting any data: retain Worktree files,
  queued inputs, configuration, conversations, tool history, terminal transcripts,
  and full audit records. Archive requires the machine online and completes only
  after the associated live resources have closed.
- Restore returns the same Session to active use without starting processes.
  A subsequent message resumes the provider where supported; a subsequent
  terminal start creates a new shell and preserves prior terminal history.
- Do not expose permanent Session deletion through first-release user interfaces
  or user-facing APIs. A future delete operation removes content and retains
  metadata-only audit; archive retains both content and full audit.
- Treat existing unauthenticated local data as development data. The first
  release does not need a legacy resource/history import flow.
- Re-enrollment after administrator removal uses a new empty machine directory
  and installation identity. Retain the old directory in place without importing
  its data. The user remains a Team member and can enroll the new identity into
  the original Team after logging in again.

## Backend capabilities

| Area | Required server behavior | Responsibility retained elsewhere |
| --- | --- | --- |
| Identity | Owned accounts, email verification/password recovery, password and Passkey login, application sessions/revocation, and client/device identity | Electron and Web implement their login entry points; daemon credentials are separate from user login |
| Subscriptions and quotas | Team billing, verified paid coverage, monthly TURN periods, Enterprise grants/audit, and atomic member/Session capacity admission | Daemon checks effective per-Session turn limits and persists fork-inherited consumption; clients display limits and billing state |
| Teams | Team creation and selection, membership/invitations, administrator/member roles, member removal, and authorization | Clients display the selected Team and available actions |
| Site administration | Explicit site grants, site name/announcement/Team-creation settings, per-operation policies, and transactional site audit | Deployment operators bootstrap and recover grants through the server CLI; Web exposes a Team-independent administration page; Web and Electron display public site settings and apply the Team-creation setting |
| Machine enrollment | Bind an installation identity and catalog origin to a Team, issue machine credentials, and support administrator removal/revocation | Daemon stores its credentials and proves its identity on outbound connections |
| Presence | Authenticated daemon connections, online status, last observed time, and machine capabilities | Daemon reports actual runtime/capture/provider capabilities; a peer connection has its own state |
| Resource catalog | Team-scoped Machine/Workspace/Session/Worktree queries, source identity mapping, synchronized directory metadata, and active/archived Session filtering | Daemon owns Workspace configuration and captured Session directories |
| Machine management | Authorize and route Workspace/Provider/machine-settings requests, correlate results, and report unavailable targets | Daemon validates paths, persists machine configuration, and performs filesystem/process changes |
| Signaling | Bind verified identities, target, SDP fingerprints, and expiry to each peer; route SDP/ICE and terminal lifecycle messages; issue ICE configuration and relay credentials; deliver revocation | Endpoints perform DTLS key exchange; daemon enforces peer authorization and the 24-hour ceiling independently of the signaling socket |
| History ingestion | Accept daemon snapshots/events and audit, deduplicate retries, record committed sequence watermarks, and propagate catalog changes/deletions | Daemon is the sole writer of execution history and retains unsynchronized data |
| History queries | Serve paginated Session summaries, conversations, tool history, and audit over HTTPS, including when a machine is offline | Clients project stored events and attach to the live daemon when operations are available |
| Archive and restore | Synchronize and query archive state while preserving all central history and audit; report completion only after daemon confirmation | Daemon pauses input delivery, closes the provider and owned PTYs without removing files or records, and restores active state without launching processes |
| API and persistence foundation | PostgreSQL migrations and server storage, shared wire contracts, authenticated API/stream errors, and deployment configuration for independently hosted clients | Native bindings remain thin; daemon persistence remains SQLite |

Authorization is enforced at both server and daemon boundaries. The initial Team
policy can grant members the same execution actions without implementing
per-resource ACLs. A discovery token or a successful SDP exchange does not
establish Team membership. Machine authentication also must not let a daemon
upload another machine's history or choose another Team's resource identity.

Session creation, prompts, backlog dispatch, steering, approvals, cancellation,
and resume retain the existing daemon execution service; archive and restore
extend that same service. The backend
does not become another ACP client or a second scheduler. Agent multi-client
collaboration and the terminal's current single-controller behavior remain
distinct.

## Local implementation changes

| Pre-backend implementation | Required change |
| --- | --- |
| [Server routes](../../apps/server/src/lib.rs) expose only `/healthz`; startup opens the catalog | Implement the authenticated control-plane APIs and daemon connection service |
| [LocalCatalog](../../crates/store/src/local.rs) creates a `Local` Team/Machine and permits use without login | Require enrollment and authenticated Team context in the integrated flow; retain local storage and resource ownership |
| [Control server](../../apps/daemon/src/control-server.ts) uses one discovery token and an authenticated boolean for local APIs | Bind requests and peers to verified identities and Team actions; local socket authentication remains a transport check |
| [Agent store](../../apps/daemon/src/agent-store.ts) constructs a `local_token` actor | Record verified user and device identities; an optional source Machine represents an actual enrolled machine, never a fabricated browser machine |
| [Fleet store](../../packages/components/src/stores/fleet.ts) fixes the target to `local-daemon` | Read the Team catalog from the backend and route operations to selected machines |
| [Router](../../packages/components/src/router/index.ts) and Session stores identify resources by unqualified local IDs | Qualify routes, caches, drafts, and pending operations by resource origin/target so equal IDs on different machines cannot collide |
| [Desktop signaling](../../apps/desktop/src/main/desktop-media-controller.ts) connects only to local IPC and reports signaling loss as peer failure | Add central signaling and backend management transports; keep valid working peers alive across signaling loss, bounded by revocation and expiry |
| [Agent](../../packages/components/src/services/agent-client.ts), [terminal](../../packages/components/src/services/terminal-client.ts), and [desktop](../../packages/components/src/composables/useDesktopConnection.ts) peers use empty ICE server lists | Apply server-issued STUN/TURN configuration to both peers and verify relayed access |
| [Session history](../../packages/components/src/stores/agent-sessions.ts) reads only through the daemon DataChannel | Add backend history reads and reconcile the stored watermark with live subscription without replaying commands |
| [Catalog notifications](../../apps/daemon/src/catalog.ts) publish immediate `catalogChanged` events | Add synchronization that recovers missed changes and records deletions independently of removed resources |
| [Session deletion](../../apps/daemon/src/agent-sessions.ts) removes resource rows and their journal | Add reversible archive/restore and remove Session deletion from first-release user operations; do not reuse destruction for archive |
| [Terminal hangup](../../apps/daemon/src/terminals.ts) removes the transcript and metadata | Add a stop-and-retain path for archive; close only Session-owned PTYs and preserve all terminal records |
| [Provider snapshots](../../apps/daemon/src/agent-providers.ts) include launch settings and environment values | Separate display metadata from configuration; keep secrets out of central replicas, command audit payloads, and logs |
| [Agent SQL](../../crates/store/src/agent/sql.rs) selects SQLite explicitly; database connections currently use one SQLite-oriented pool configuration | Implement PostgreSQL server persistence |
| [Renderer CSP](../../apps/desktop/src/shared/renderer-csp.ts) forbids network access and UI code calls `window.deskfleet` | Extract shared UI behind application adapters; Electron supplies a main-process/preload adapter and Web supplies a browser API/signaling adapter |

Reuse the catalog, ACP execution, durable history, managed worktrees, terminals,
Git inspection, and native WebRTC. Replace their unauthenticated ownership
context, single-target routing, and local-only control-plane connections.

Keep machine settings persisted on the machine. Forwarded Provider configuration
may pass through the authorized API, but launch environment values and CLI
credentials do not belong in the central catalog/history. Synchronize only the
Provider metadata needed for selection and display.

The one-shot [agent CLI](../../apps/daemon/src/agent-cli.ts) starts a provider
directly in a chosen working directory for adapter diagnostics. It does not
create managed resources or provide an unauthenticated path into Team Sessions.
A future production CLI/MCP client should use the same authorized operations as
the interactive clients.

## Data ownership and synchronization

Server-owned records cover users, login/device sessions, Teams, memberships,
machine enrollment, and access policy. Daemon-owned records cover Workspace
configuration, Session execution context, provider runs, inputs, turns,
permissions, and the event journal. The server stores queryable replicas of the
latter; it does not independently mutate live execution state.

Keep database-assigned integer resource IDs encoded as decimal strings. Existing
catalog `originId` qualifies local IDs. Enrollment maps those identities to the
central Team/Machine; it must not equate two independently allocated integer IDs.
Server persistence and client references must preserve this association.

History synchronization builds on the existing per-Session sequence and atomic
commit-before-publish behavior. It needs an initial consistent snapshot, batches
of subsequent events, a durable acknowledged watermark, and retry deduplication.
Catalog updates, such as Workspace deletion, need equivalent recoverable state
because they are not all represented by a Session journal. Archive/restore state
must also synchronize without removing Session history. The implementation may use
snapshots or incremental change records where appropriate.

History responses report how far the server has synchronized and when the
machine was last observed. A disconnected machine is not proof that its last
recorded run has stopped. The UI separates machine reachability, peer connection
state, recorded execution state, and history completeness. Reconnecting attaches
and fills history gaps without reissuing accepted commands.

Archive/restore preserves local and central conversation/tool content and full
audit records. A future permanent delete operation must remove conversation
content embedded in central command parameters/results as well as event history,
retain metadata-only central audit, and prevent stale uploads from restoring
deleted content. This permanent-deletion work is outside the first release.

## Team AI usage

Team settings expose AI usage to both administrators and members through the
existing `ReadUsage` policy. `GET /api/teams/{teamId}/ai-usage` accepts `period`
(`24h`, `7d`, `30d`, or `all`) and an IANA `timeZone`. It returns token totals,
reporting coverage, model/member distributions, trend buckets, the last 53 weeks
of daily heatmap values, and the latest history synchronization time.
`GET /api/teams/{teamId}/ai-usage/sessions` accepts a local `date` and the same
timezone, returning up to 100 Sessions ordered by reported tokens with a
truncation indicator. Neither endpoint returns conversations or event payloads.

The source is the current synchronized Session snapshot for each machine in the
Team, including archived Sessions and removed machines' retained history. Count
each terminal turn once, excluding explicitly unconsumed attempts. Replayed
events and repeated synchronization do not add usage. Attribute a turn to its
initial input's user and its model snapshot at dispatch; missing attribution is
shown as unknown. Steering inputs do not redistribute a turn among members.

Aggregate provider-reported `totalTokens` directly. Input/output and cache
categories are shown separately and are not added to that total. The API also
retains the optional reasoning-token subtotal.
Missing usage is distinct from an explicit zero; coverage reports the number of
turns with usage against all eligible turns. Optional categories stay unknown
when no turn reports them. The dashboard reflects synchronized, reported data,
not provider billing: offline or unsupported providers can leave gaps, and
historical records are not reconstructed from current configuration.

Turn completion time determines the bucket. The 24-hour period is rolling with
hourly buckets; 7- and 30-day periods include today and use local calendar-day
boundaries, including daylight-saving changes. All-time uses daily buckets.
Empty buckets are retained, and the heatmap always covers the last 53 weeks
independently of the selected period. Costs and pricing are outside this panel.

## Session archive and restore

Archive is a durable Session state, distinct from a stopped provider process.
It prevents new execution and backlog dispatch until explicit restoration.
Stopping the provider closes live permission callbacks without granting them;
inputs, permission records, and their resulting state transitions remain in the
journal. Reopening an archived view reads history without starting the provider
or automatically creating a terminal.

The daemon retains the original Worktree records and directories, including
uncommitted changes and untracked files. Terminal closure is based on Session
ownership, not cwd: unrelated terminals in the same directory keep running.
Terminal transcripts and metadata remain on the daemon for read-only replay.
No archive path calls Session destruction, force-removes a Git worktree, or uses
the existing destructive terminal hangup implementation.

The machine must be online to archive. Do not report archive success or queue
an offline archive for later execution. An incomplete attempt reports its
unfinished state and can be retried without discarding data. Successful archive
means the associated live processes have closed and their final output/state
has been retained.

Restore returns the same Session identity, execution context, and history to
the active list. It does not start a provider, dispatch pending inputs, or
create terminals. Later explicit use starts the needed processes under the
existing provider resume rules. An ended PTY is not revived; a newly opened
terminal gets its own identity while old transcripts remain available.
Archived Sessions still belong to their Workspace and prevent its deletion.

## Shared Vue clients

Create a common component package for the resource tree, Workspace/Session
views, composer, conversation/tool/approval rendering, Git views, terminal
presentation, and reusable settings controls. Share appropriate view models and
client operations without coupling the package to Electron globals or importing
daemon runtime code into the browser.

Electron retains tray/window lifecycle, OS integration, local daemon hosting,
local permissions, and its narrow preload bridge. Its remote API/signaling
adapter can live in the main process, preserving the renderer boundary. Web
uses browser APIs and has no local daemon installation or OS-control bridge.
Both frontends use the same backend API and target-machine operation contracts.
The API-only backend does not serve the Vue application.

Browser identity must be modeled explicitly: the user and client/device are
known, but the browser need not run on an enrolled Machine. Adapt the current
required `AgentActor.sourceMachine` field rather than inventing a Machine to
satisfy it. Credentials and authenticated actors are supplied by the transport,
not by untrusted operation parameters.

## Delivery order and acceptance

1. Establish PostgreSQL server persistence, shared identities/contracts, owned
   accounts, Teams, roles, and enrollment. Replace unauthenticated local creation gates.
   Start extracting shared Vue components and application adapters in parallel.
2. Connect daemon presence, authenticated management APIs, signaling, and ICE
   configuration. Implement the [peer identity/key exchange contract](webrtc-security.md),
   including revocation and 24-hour authorization expiry. Make both clients
   select and operate a remote target.
3. Add catalog/history synchronization, central history reads, and reversible
   Session archive/restore with resource closure and complete data retention.
   Integrate active/archived lists and cached history with live Session views
   in both clients.
4. Complete the end-to-end checks below with the real backend, two machines,
   Electron, and the separately hosted Web client.

The release workflow is: log in, select a Team, enroll a headless machine,
configure a Provider and a Workspace with ordered directories, create a Session,
run an Agent, inspect Git, and open a terminal from another client. Verify both
direct and forced TURN connections.

The identity/subscription replacement additionally follows the
[delivery boundaries](identity-billing.md#delivery-boundaries) and
[acceptance scenarios](identity-billing.md#acceptance-scenarios): real password
and Passkey login, concurrent Team quota admission, fork-inherited turn limits,
date-anchored TURN, expiry without grace, and manually assigned Enterprise.
Forced TURN checks must use an eligible plan or self-hosted configuration, and
Free must be verified to receive no relay credentials.

Acceptance also covers:

- A second member can view and operate the same Session; users outside the Team
  cannot discover or operate its resources. Administrator-only actions reject
  ordinary members at the API boundary.
- Equal local resource IDs on two machines remain distinct in queries, routes,
  cached views, and commands. Audit attributes the real user/device and target.
- Closing a viewer leaves Agent and shell execution running. Reconnection does
  not duplicate prompts or create another shell, and disconnection never grants
  a pending approval.
- Taking the executing machine offline leaves its synchronized Agent history
  readable with its synchronization watermark. Terminal output remains a
  daemon-only capability.
- An established working WebRTC peer remains usable during signaling loss within
  its existing grant. Fingerprint/context mismatch rejects a connection;
  revocation or the 24-hour deadline closes access without stopping executing
  Agents or shells. Signaling reconnect does not extend authorization.
  Reconnecting synchronization catches up without duplicating events.
- Archive requires the machine online and closes the provider and Session-owned
  PTYs before reporting success. Unrelated terminals keep running. Worktree
  files, uncommitted/untracked changes, backlog, terminal records, conversation
  history, and audit remain intact locally and in their existing central copies.
- Restore preserves identity and data, returns the Session to the active list,
  and starts no processes or backlog dispatch. Subsequent messages or terminal
  use start only the required processes; archived history views never do so.
- Neither Electron nor Web exposes permanent Session deletion, and first-release
  user-facing APIs do not offer that operation.
- PostgreSQL server integration and SQLite daemon behavior are tested at their
  respective storage boundaries. Browser and Electron exercise the shared UI
  with their actual adapters.

MCP coordination and desktop-control expansion follow this remote Agent/Git/
terminal workflow. Workspace-scoped terminals are an existing architecture goal
but not currently implemented; they are a daemon feature gap, not a central
server persistence requirement. Protocol contracts continue evolving at
`PROTOCOL_VERSION = 1`.
