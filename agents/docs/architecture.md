# deskfleet architecture

deskfleet manages AI agents and their working environments across a team's
computers. Users can browse workspaces and session history, inspect Git state,
and access terminals or desktops on the machine doing the work.

The central Actix Web API uses PostgreSQL for OIDC application sessions, Teams,
machine enrollment, access grants, and synchronized catalog/history. Electron
and the independently hosted Web app share the Vue UI and authenticated client
operations. Each TypeScript daemon connects outbound to the backend and keeps
its execution journal in SQLite through napi-rs. Management uses authenticated
backend APIs; Agent interaction, Git, files, terminals, and desktop streams use WebRTC.

The daemon runs from source, as a SEA executable, or inside the Electron main
process. It owns ACP providers, the shared backlog, steering, permissions,
Session archive/restore, and native media. Electron retains a sandboxed renderer
and stays in the tray after its windows close. The local discovery socket serves
host setup, enrollment, and shutdown; it does not authorize team resource access.
The MCP facade below remains follow-up work.

## Components

```mermaid
flowchart LR
    Client["Electron / Web client"] <-->|"HTTPS / WebSocket: catalog, history, signaling"| Server["Actix Web server"]
    Server <-->|"Outbound connection: presence, history, signaling"| Daemon["Machine daemon"]
    Client <-->|"WebRTC: operations, files, terminal, media"| Daemon
    Daemon <-->|"ACP"| Agent["Agent process / adapter"]
    Agent <-->|"MCP tools"| MCP["deskfleet MCP facade"]
    MCP <-->|"Operations on a target machine"| Target["Target daemon"]
    Daemon <-->|"napi-rs"| Native["Rust native capabilities"]
    Client -.->|"Relay fallback"| TURN["TURN service"]
    TURN -.-> Daemon
```

| Component | Responsibility | Implementation |
| --- | --- | --- |
| Central server | Team membership, machine registration, catalog, stored session history, presence, access control, and signaling | Rust / Actix Web |
| Machine daemon | Workspace configuration, agent supervision, ACP clients, terminals, Git access, and history synchronization | TypeScript library; Node.js SEA or bundled Electron host |
| Native libraries | OS integration and performance-sensitive transport, capture, input, and media work | Rust with napi-rs bindings |
| Desktop application | User interface, platform integration, and daemon installation/management | Electron / TypeScript |
| Web application | Independently hosted frontend for catalog, history, and browser-supported remote access | Vue / TypeScript |
| MCP facade | Let agents discover resources and operate on explicit remote targets | TypeScript, sharing deskfleet client operations |

The server owns team membership and shared access policy. Each daemon owns its
machine's workspace configuration, files, processes, and live session state. The
server stores synchronized views so users can browse history while a machine is
offline; clients show when that data was last observed.

The backend is open source in this repository under Apache-2.0. Shared resource
and protocol types remain independent of Actix Web and Node-API.

## Identity and team access

The first backend release prioritizes the officially hosted service and uses
OIDC for user login. The Rust backend is API-only. An independently hosted Vue
Web client and the Electron client share a common UI component package.
Creating resources requires an authenticated user and a selected Team.
Headless machines need enrollment into that Team before accepting
resource creation; their ongoing server connection uses machine credentials,
separate from a user's interactive login.

Team members can operate all machines in their Team by default. The initial
roles are administrator and member. Administrators manage members and roles and
remove machines. Members can enroll their own machines, configure Providers,
create or delete Workspaces, and create, archive, or restore Sessions. The first
release does not expose Session deletion to users. Per-Workspace sharing rules are not
part of the initial role model. Server and daemon authorization still checks the
requested action and Team rather than treating a connected peer as authority.

The current automatically created local Team and discovery-token actor are
development scaffolding for this flow. They do not establish authenticated Team
membership and must not authorize resource creation in the integrated product.
Local IPC remains a transport for the local client after enrollment. Existing
unauthenticated local data is development data; the first release does not
include an import flow for it.

The [backend implementation scope](backend.md) tracks the required capabilities,
existing local assumptions, delivery order, and acceptance criteria.

## Resource model

```text
Team
  Machine
    TerminalSessions [machine scope]
    Workspace
      Ordered directory paths [one or more; first is default]
      AgentSessions
        Managed Worktree [created and removed with the Session]
      TerminalSessions [machine, workspace, or worktree scope]
```

| Resource | Meaning |
| --- | --- |
| Team | Membership and shared access boundary |
| Machine | An enrolled daemon installation and its OS user execution context |
| Workspace | A named, machine-local configuration of one or more ordered directory paths |
| Worktree | An execution context owned by one Session; the catalog also keeps an internal main context for Workspace directories |
| Directory binding | An unnamed path with a stable position; position zero is the default directory |
| AgentSession | A workspace session with its captured execution context and provider identity |
| TerminalSession | A terminal owned by one Machine, Workspace, or Worktree, with a separate cwd |

A Workspace must be created with at least one existing directory. Its paths are
ordered and have no user-assigned aliases; the first path is the default working
directory. The catalog stores these paths in one internal main Worktree created
in the same transaction. The UI presents them as Workspace directories, without
exposing that storage record as a separate Worktree. A new Workspace has no
Sessions to display. New-session composition targets the Workspace; an existing
Session exposes its own Worktree. Updating the Workspace changes its configured
directories without retargeting existing Session contexts.

Worktrees are not independently maintained resources. Each Session record owns
one Worktree record, created and destroyed with it. Creating a Session chooses
its context. A **worktree** Session allocates generated checkouts; destroying it
removes them. A **directory** Session records the Workspace's current paths and
works in them directly, including their uncommitted changes and non-Git
directories; destroying it removes only its records, never those files. The
choice is immutable. Sessions sharing directories are not isolated from each
other or from the user's own edits. For worktree contexts, the daemon creates detached Git worktrees
from the configured checkouts' HEAD commits, grouping paths in the same checkout
and preserving subdirectory positions. Uncommitted source changes are not copied.
The first path is the Session's default working directory. Workspace paths may
be non-Git for main-context terminals and directory Sessions; creating a worktree
Session requires Git-backed paths with a commit.

Archiving is the normal way to finish using a Session. It closes the provider
and Session-owned terminals while retaining the Session, its Worktree and files,
queued inputs, conversation/tool history, terminal transcripts, and audit.
Archive never invokes Worktree destruction or deletes uncommitted or untracked
files. The machine must be online, and archive completes only after the daemon
confirms that the associated live resources have closed. Restoration keeps the
same Session identity and execution context and returns it to the active list
without starting processes. A later message resumes the provider where supported;
opening a terminal can create a new shell while retaining old terminal history.
Archived Sessions remain owned by their Workspace and continue to prevent its
deletion. Session deletion is not a first-release user operation; existing
destructive implementation paths are not archive handlers.

For example:

```text
Machine: development-box
  Workspace: storefront
    Directories:
      /code/storefront-web  [default]
      /code/storefront-api
    Session: investigate checkout failures
      Worktree: automatically generated checkouts for this Session
```

Each checkout retains its own Git state. Resource IDs are independent of names,
paths, and repository URLs. Resources on different machines remain distinct even
when they share a repository remote.

A terminal's scope determines its association and access policy. Its cwd can
change without reparenting the terminal. Machine and workspace terminals need no
placeholder worktree. Resource ownership itself does not sandbox a shell's
filesystem access.

### Catalog persistence

`deskfleet-store` persists resource catalogs with SeaORM. The first schema
contains `teams`, `machines`, `workspaces`, `workspace_sessions`, `worktrees`, and
`worktree_directories`. The main Worktree stores each Workspace's configured
paths; Session-owned Worktrees store derived paths. Shared types in
`deskfleet-model` remain independent of the ORM.

Resource primary keys and foreign keys are signed 64-bit integers, allocated by
their owning catalog database. SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT`;
the same SeaQuery migration renders PostgreSQL `BIGINT` identity columns.
Resource IDs cross JSON boundaries as decimal strings to preserve precision in
JavaScript. They are unique within their resource table and catalog database,
not independently allocated identities that can be merged across databases.
Identities such as public user IDs that need to conceal internal numbering use
UUIDv7 instead; no user table is introduced in this schema.

Parent foreign keys enforce the resource hierarchy. Teams and machines with
children cannot be deleted. A Workspace with Sessions cannot be deleted; deleting
one without Sessions removes its main Worktree and directory rows. Session deletion
cascades to its managed Worktree. Main Worktrees have no Session ID, and each
Workspace has exactly one main context. Directory rows are keyed by Worktree and
position, with no name column. Paths must be nonempty and unique in the ordered
collection; filesystem validation belongs to the daemon.

Workspace creation and updates write the main Worktree and its nonempty directory
collection atomically. Reads preserve directory order. The default directory is
always the first path, so no separate default flag can diverge from ordering.
The store is a persistence boundary, not an authorization boundary.

`deskfleet-migration` owns explicit, reversible SQLite catalog migrations. The
central server uses independent PostgreSQL migrations in `deskfleet-control-store`
and applies them before accepting requests. Central storage owns OIDC identities,
login sessions, Team policy, enrollment, peer grants, and replicas qualified by
central machine and local resource IDs. The local journal retains SQLite-specific
SQL. Both stores have integration tests against their actual database engines.
See the [server guide](../../apps/server/README.md) for configuration and migration
commands.

The daemon opens the active machine's `catalog.db` through a thin `NativeCatalog`
napi binding after acquiring discovery. The initial directory is `machine/`;
later registrations use `machines/<uuid>/`, selected by `active-machine.json`.
The local catalog
keeps its persistent origin and integer machine/resource IDs. Enrollment binds
that origin to the central Team and Machine. Earlier unauthenticated development
data outside `machine/` is not imported into the enrolled machine.

Machine removal revokes its credential without removing the user's Team
membership or stopping accepted execution. Explicit re-enrollment closes the
old execution context and selects a new empty directory and origin. The old
directory remains at its original path, preserving Git worktree registrations
and history. The new identity may join the original Team or a different Team;
it never imports the previous registration's resources. Valid registrations
cannot be reset through this flow.

Authenticated backend management exposes catalog queries, Workspace
create/update/delete, and Session create/archive/restore. The daemon validates
Workspace paths as absolute, existing directories. There are no manual Worktree
mutations or user-facing permanent Session deletion. Changes synchronize to the
central catalog and notify Team clients. Workspace deletion never removes its
configured source directories, and retained archived Sessions block deletion.

The shared folder dialog lists directories through backend RPC on the selected
daemon. It returns the current path, parent, home, roots, and child directories.
Clients treat paths as opaque so browsing follows the target machine's rules.

Worktree Session creation allocates a durable ID and creates Git worktrees beneath
`<machine directory>/session-worktrees/<session ID>/` by default. The host's
`<daemon directory>/worktree-settings.json` can select an absolute root directory,
configured through Desktop Settings → Preferences → This computer. Each new
worktree Session reads the current preference and creates custom checkouts under
`<root>/<catalog origin>/<session ID>/`; the catalog origin keeps repeated local
IDs in different machine registrations separate. A changed root affects new
Sessions without restarting the daemon or moving existing checkouts. An
unavailable configured root fails creation instead of falling back to the
default disk. Directory Sessions continue to use their Workspace paths.

Ownership manifests remain beneath the machine's `session-worktrees/` directory
and record custom checkout locations independently of the current preference.
Provisioning failure rolls back partial checkouts. Archive
retains those checkouts and their local changes; disconnect never destroys them.
Internal destruction remains available for rollback and development tests only.

Electron reaches the backend through its main-process transport and narrow
preload bridge. Web uses its browser transport. Both use the selected central
Machine identity for routes, caches, drafts, and commands; integer local IDs do
not identify resources across machines. The UI displays synchronized history
while a machine is offline and attaches through WebRTC for live Agent, Git, and
terminal operations. The working directory remains separate from terminal
ownership. Failed Session provisioning remains visible without a fabricated
Worktree; terminal transcripts stay solely on the daemon.

## Daemon and session lifecycle

The daemon runs as the OS user whose files, credentials, and tools the agents
use. Closing a window or losing a connection must leave ongoing work running.
Local clients connect over authenticated IPC, such as a Unix-domain socket or
Windows named pipe.

Desktop Settings has a persistent **Run local Agent** preference, enabled by
default. The app bundles `@deskfleet/daemon` and starts it in its own main
process, with the bundled native addon and runtime. The daemon's lifetime is the
app's: it keeps running while the app sits in the tray with no windows, and the
app waits for its cleanup before exiting. The app never spawns a separate daemon
process. The standalone Node.js SEA is the headless distribution of the same
daemon and runs independently of any desktop app.

After acquiring discovery and initializing local IPC, the daemon requests the
OS permissions needed by its implemented desktop capture capabilities. On macOS
this is screen/system-audio recording consent, requested in the process hosting
the daemon before a remote client uses it. Permission prompts and denial must not
block headless operations. Settings displays permission status separately from
daemon availability; capture and encoding still start only on explicit use.

Startup reuses an authenticated daemon already owning the discovery directory,
such as a standalone SEA, instead of hosting another. Explicitly disabling the
preference sends authenticated shutdown and waits for the discovery lease to be
released after cleanup. It ends live terminal processes but retains catalog and
terminal history. Quitting the app closes the daemon it hosts in the same way;
a reused standalone daemon is only disconnected. Disabling auto-start does not
kill a separately started daemon when the app next launches. Startup/shutdown
errors and retries appear in Settings.

The desktop app stays resident in the system tray (the macOS menu bar or the
Windows notification area), so its daemon and notifications stay available.
Closing its window or using an ordinary quit command hides it. The tray menu,
OS session end, or a termination signal quits the app and its hosted daemon.

The daemon is the ACP client and owns local agent processes or adapter
connections. Each AgentSession belongs to a Workspace and captures its Worktree execution
context at startup; later edits to the Workspace must not silently retarget a
running session. Additional directories are exposed through the provider's
supported configuration or tools.

Settings also has an **Agents** section for the target machine's providers.
The daemon owns their names, templates, binary paths, and environment overrides
in `<daemon directory>/agent-providers.json`. Templates are immutable after
creation. A Session retains its configured provider ID, and each new provider
process resolves the current settings. Editing or removing a provider does not
stop existing processes or delete their history; a removed provider cannot
start again. Provider launch settings remain outside the Session journal.

The Codex template connects Codex CLI through the bundled
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp). The Claude
Code template connects Claude Code CLI through the bundled
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp).
The Cursor template launches the installed Cursor CLI directly as `agent acp`;
Cursor speaks ACP and does not use a bundled adapter. After initialization it
calls `authenticate` with `cursor_login` when Cursor advertises that method.
The Grok template launches the installed Grok CLI directly as `grok agent stdio`.
It authenticates with `xai.api_key` when `XAI_API_KEY` is set, and otherwise with
`cached_token` after `grok login`.
The shared
`AgentProvider` interface accepts a user-facing name, an optional binary path,
and environment overrides. Provider-specific code selects the process; the
[ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) handles
initialization, session creation, prompts, cancellation, and session updates.
Each bundled adapter uses the installed CLI and its credentials. Adapters run as
child processes; the SEA executable reuses its bundled Node runtime.
The generic ACP template launches a stdio ACP executable directly. Empty binary
paths use the template default (`codex`, `claude`, `agent`, `grok`, or `acp-agent`), and configured environment
values extend the executing daemon's inherited environment. New installations
start with a default Codex provider; the new-session composer chooses among the
machine's configured providers. See [Agent Sessions](agent-sessions.md) for
configuration and lifecycle details.

The current agent CLI creates one ACP session per prompt invocation. With
`--workspace-id`, it asks the running daemon to allocate a managed Session and
uses its first derived directory as cwd. It closes the provider process before
destroying that Session and its generated Worktree, including on prompt or
initialization failure. Direct `--cwd` invocations remain outside the managed
Workspace lifecycle. Provider session IDs remain separate from database Session
IDs. The CLI forwards ACP updates without converting them into a history schema.
Permission requests require a client callback; without one they are cancelled.
The CLI cancels them explicitly. The client advertises no filesystem or terminal
capabilities.

ACP capability negotiation determines which operations an adapter supports.
Pi is a further integration candidate. Managed
sessions, imported history, resumed sessions, and attachment to an existing CLI
process are distinct capabilities. ACP alone does not guarantee live attachment;
a tmux connection can expose the CLI without providing structured ACP control.

The [Agent Session service](agent-sessions.md) persists provider identity,
inputs, execution turns, command audit, permissions, user questions, and an ordered event journal
in the daemon's SQLite catalog. Clients connect to a daemon ACP facade over
DataChannel; the daemon remains the sole ACP client toward each provider process.
Credentials remain on the executing machine. ACP approval callbacks do not confine
agents that execute tools directly.

The composer discovers model, reasoning, and mode choices from the provider through the
same ACP DataChannel facade. Draft discovery uses a temporary provider session in
the Workspace's default directory without creating a managed Session or Worktree.
Session creation applies the selected configuration before delivering prompts;
existing Session controls change these choices between turns on that Session's
provider connection. A Session's provider identity cannot be changed.
Configuration options and confirmed changes use the existing ACP event journal
so attached viewers can follow them.

All authorized users and devices can operate on a Session concurrently, without
control ownership or transfer. Commands record the initiating user and source
machine separately from the executing machine. Pending inputs appear in a shared
candidate backlog; users can also explicitly steer the active turn when the
provider supports it. The daemon coordinates input delivery and permission
decisions and structured user questions, with the first valid response resolving
each shared request.
Reconnecting clients attach by journal cursor without resubmitting inputs.
Disconnect never grants approval or stops the Session.

Daemon restart recovery depends on the provider and terminal backend. Reconcile
stored history with available processes and report interrupted sessions. On
supported Unix systems, tmux can keep terminals alive across daemon restarts;
other PTY backends expose their own recovery capabilities.

## Remote access and coordination

Machines make outbound connections to the central server. Peer connections are
created on demand.

| Traffic | Transport |
| --- | --- |
| Authentication, enrollment, catalog, and history | HTTPS |
| Workspace, Provider, and machine-settings management | HTTPS API; server authorizes and forwards to the owning daemon |
| Presence, history synchronization, and WebRTC signaling | Authenticated WebSocket or HTTPS streams |
| Terminal dial, hangup, catalog and lifecycle events | Authenticated signaling; IPC for the local client |
| Interactive operations, Git queries, terminal I/O and resize | WebRTC DataChannel |
| Agent prompts, steering, permissions, and live Session events | ACP and deskfleet extensions over WebRTC DataChannel |
| File browsing, transfer, and Agent file references | Independently authorized files WebRTC DataChannel |
| Desktop video/audio | WebRTC media tracks |
| Desktop input | WebRTC DataChannel |
| Local discovery, catalog operations, and signaling | Authenticated IPC; Agent and terminal streams use DataChannels |

Deploy STUN and TURN alongside signaling. TURN provides relay access when peers
cannot connect directly. Desktop streaming, terminal traffic, and bulk results
need flow control appropriate to their latency and throughput; validate this
with the selected WebRTC implementation.

The native transport uses `webrtc-rs` with configurable STUN/TURN servers,
trickle ICE, reliable ordered DataChannels, RTP media tracks, and RTCP feedback.
`PeerSessions` gives the daemon ownership of peer creation and shutdown. These
are exposed to the local Electron client over authenticated Unix-domain sockets
or Windows named pipes. Central server signaling, remote enrollment, and remote
operation routing remain to be connected. Chromium receives the media into a
standard HTML video element; a separate native GPU rendering window is deferred.
See [native media](media.md) for codec support, capture lifecycle, and validation.

The [WebRTC key exchange design](webrtc-security.md) uses trusted HTTPS/WSS
signaling to bind authenticated user/device and target Machine identities to
each peer's SDP fingerprints. The endpoints perform standard DTLS certificate
verification and key exchange; DataChannels use DTLS and media uses DTLS-SRTP.
The server does not receive private transport keys. Each new peer uses a new
authorization and endpoint-generated certificates, distinct from login and
machine enrollment credentials. No additional application encryption protocol
or independently verified device-pairing mechanism is part of the first release.

Electron terminals use a data-only peer on the same signaling infrastructure.
The daemon owns native PTYs independently of their viewers; disconnect detaches,
and an existing terminal can be listed and reattached without restarting its
shell. The UI supports local machine-scoped terminals. See
[terminal integration](terminals.md) for dial/hangup, durable history, and flow
control.

Git inspection uses the Git CLI's machine-readable output on the owning daemon.
Session-scoped queries resolve the captured directories to their checkouts and
retrieve branch, HEAD, staged/unstaged/untracked status, and file diffs. Several
bindings in one checkout share its result; non-Git directories remain usable and
are identified separately. Queries use the existing ACP DataChannel and do not
write history or change the index. The visible Changes panel refreshes status
and its open diff every 1.5 seconds after each completed read, including edits
from terminals and external editors. Closing the panel or hiding the window
stops polling. Git results remain transient; Session provisioning still owns
creation and deletion of managed worktrees.

The machine's Remote control page groups Terminal, Desktop, and File transfer.
Tools mount when first visited and retain their connections while switching tabs.
Machine-owned shells live here; Session-owned shells stay in the Session panel.

Machine file access shares one service between the two-pane transfer panel and
Agent Markdown resources. File peers and the transfer queue have independent
lifetimes from Sessions and desktop media. Electron's main process owns its
queue and local filesystem endpoint; Web owns its queue at page/account scope
and uses explicitly selected browser directory handles. A folder is one queue
item, with its contents staged before native publication. Relative Agent file
references resolve against the Session's captured first directory. See
[files and transfers](files.md) for authorization, conflicts, browser limits,
and live-reference semantics.

MCP tools let an agent discover authorized machines and resources, inspect state,
and request operations on an explicit target. Remotely created sessions belong
to worktrees on that target machine. The agent coordinates related work across
machines; deskfleet does not create a global Project or synchronize repository
contents automatically.

The MCP facade shares the same operations and permissions as human clients.
Its placement and provider configuration will be selected during integration.

## History and authorization

The central server stores synchronized conversation and tool history, not just
session names. The daemon retains unsynchronized events during server outages.
Synchronization must tolerate retries and distinguish incomplete history from a
complete recording. The [Agent Session persistence design](agent-sessions.md)
extends the SQLite/SeaORM catalog with command audit and a per-Session sequence.
The daemon commits events before publishing them; the server synchronizes a
qualified Session identity and completeness watermark. The owning daemon remains
the single writer even when multiple clients operate concurrently.

Live commands require an available target machine. Terminal output is persisted
on the owning daemon until explicit hangup so a different client can reconstruct
the session. Reconnecting does not restart the shell. Daemon restart retains the
transcript and marks lost processes interrupted. Desktop media remains transient.

Authorize history access, prompts, approvals, terminal input, and desktop control
as separate actions. Both the server and target daemon enforce the caller's
scope. Authenticate remote peers and local IPC callers; a WebRTC connection or
signaling access alone does not authorize machine operations.

Agent MCP calls carry delegated authority. Generated arguments cannot broaden
that authority, and discovery exposes only permitted resources. Remote actions
remain attributable to their initiating user/session and target resource.

The first backend release assumes the central service is available for login,
enrollment, authorization, and management. It does not add offline resource
creation or a separate offline-authorization system. An established, authorized
WebRTC connection can continue working when its signaling connection is lost,
within its existing grant. A grant ends on peer closure, explicit revocation,
or 24 hours after issuance, whichever comes first. The daemon enforces expiry
even without signaling, and reconnecting signaling does not extend it. Renewal
uses current authentication and a new peer. Logout, membership removal, and
machine removal revoke the affected peers; notices take effect when delivered,
with expiry bounding access if the control connection is unavailable. Revoking
access or expiring a peer detaches viewers without cancelling Agent execution,
terminating shells, or archiving a Session. Details are owned by the
[peer authorization lifecycle](webrtc-security.md#authorization-lifetime-and-revocation).

The initial design trusts the server with synchronized Agent conversations,
tool history, and audit. Terminal output remains on the daemon. Archive and
restore preserve all this data, including content-bearing audit records.
Permanent Session deletion is deferred from the first user-facing release.
When introduced, it removes central conversation/tool content, including raw
content in audit parameters and results; only audit metadata remains, and stale
uploads must not restore removed content. Keep machine private keys and
application credentials out of history and logs. Electron renderers stay
sandboxed, with narrow preload interfaces; agent output and repository content
are untrusted display data.

## Native code and distribution

Keep reusable Rust logic separate from napi-rs wrappers, following Heron's
core-crate, binding, and TypeScript-service structure. Native operations must
avoid blocking Node's event loop. Keep capture and encoding data in native code
where passing frames through JavaScript would add unnecessary copies.

Node.js SEA packages the daemon and native addon with the pinned Node runtime.
The addon is extracted to a private temporary directory before loading. See the
[daemon guide](../../apps/daemon/README.md) for packaging and platform support.
Desktop builds bundle the same daemon library with Electron and an unpacked
native addon. Neither distribution requires an external Node installation.
Agent adapters and external tools may have their own runtime requirements.

Desktop capability is optional and initialized on demand. Missing displays or
capture permissions must not prevent agents, Git, or terminals from working.
Determine whether capture needs a process in the logged-in graphical session
when implementing the platform backend.

## Repository and protocol

The Rust workspace contains:

| Crate | Responsibility |
| --- | --- |
| `deskfleet-model` | Resource IDs, directory bindings, and session associations |
| `deskfleet-store` | SeaORM entities and transactional catalog persistence |
| `deskfleet-migration` | Catalog schema migrations and optional migration CLI |
| `deskfleet-protocol` | Shared wire contracts and protocol version |
| `deskfleet-control-store` | PostgreSQL central identity, authorization, catalog, and history persistence |
| `deskfleet-native` | Native capabilities independent of Node.js |
| `deskfleet-capture` | Native display capture and retained GPU surfaces |
| `deskfleet-input` | Display-relative desktop input, held-state cleanup, and macOS/Windows injection |
| `deskfleet-encoder` | VideoToolbox/NVENC/Media Foundation hardware video encoding and Opus audio encoding |
| `deskfleet-nvenc` | Windows NVENC session and D3D11 resource ownership |
| `deskfleet-nvenc-sys` | Windows NVENC FFI and runtime driver loading |
| `deskfleet-node` | napi-rs wrapper over native capabilities |
| `deskfleet-server` | Actix Web application in `apps/server` |

Dependencies flow `server -> protocol -> model`, `server -> control-store -> protocol`,
`node -> store -> model/migration` for local catalog persistence,
`node -> native -> capture/encoder/input`, and
`@deskfleet/daemon -> @deskfleet/native`. The pnpm workspace contains the daemon,
Electron and Web applications, the native package, `packages/client` for shared
contracts/transports, and `packages/components` for Vue UI, stores, and routes.
TypeScript control wire types derive from the Rust protocol crate; napi
declarations describe the native API separately.

`PROTOCOL_VERSION` stays at `1` until the first freeze is explicitly declared.
Contracts evolve in place, including incompatible changes. Do not add version
bump tasks or compatibility layers for earlier provisional shapes.

mise manages tools and tasks with lockfile mode enabled. APM owns the checked-in
skills. See the [development environment](environment.md), [CI workflow](ci.md),
and [agent guide](../../AGENTS.md) for repository conventions.

## Backend acceptance

The [backend implementation scope](backend.md) covers OIDC and Teams,
PostgreSQL, enrollment, authorized management APIs, signaling, synchronized
catalog/history, reversible Session archive, and the shared Vue component
package with an independent Web client. The acceptance workflow in both Electron
and Web is: log in, select a Team,
enroll a headless machine, configure a Workspace, create a Session with its
execution context, run an Agent, inspect its Git state from another machine,
and open a terminal. Work continues after closing the client, reconnecting
restores the Session view, and synchronized history remains available while the
machine is offline. Validate direct and TURN-relayed connections.

MCP coordination follows that workflow. Provider
distribution, additional terminal backends, and Linux capture/encoding remain
separate follow-up work.

## References

- [Actix Web](https://actix.rs/docs/getting-started/)
- [ACP transports](https://agentclientprotocol.com/protocol/v1/transports)
- [ACP capabilities](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [WebRTC connectivity](https://webrtc.org/getting-started/peer-connections)
- [Node.js SEA native addons](https://nodejs.org/api/single-executable-applications.html#using-native-addons-in-the-injected-main-script)
- [Node-API ABI boundaries](https://nodejs.org/api/n-api.html#implications-of-abi-stability)
- [Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Heron napi crate](https://github.com/minori-live/heron/blob/main/crates/dsp-node/Cargo.toml)
- [Heron native packaging](https://github.com/minori-live/heron/blob/main/apps/desktop/electron-builder.yml)
