# deskfleet architecture

deskfleet manages AI agents and their working environments across a team's
computers. Users can browse workspaces and session history, inspect Git state,
and access terminals or desktops on the machine doing the work.

This document describes the planned system. The current implementation contains
the Rust resource model, a SeaORM catalog with SQLite persistence, an Actix Web
liveness endpoint, and an independent TypeScript daemon calling a napi-rs addon.
The desktop client manages workspace directory configuration through the daemon.
The daemon runs from source or a SEA
executable, exposes native information and a local health endpoint, and runs
Codex CLI sessions through ACP. Native WebRTC peers, DataChannels, and on-demand
capture/encoding are available through the daemon's native API. The Electron
client uses authenticated local IPC for desktop signaling and Chromium WebRTC
for decoding and playback in its sandboxed Vue renderer. It stays in the tray
independently of the daemon.

## Components

```mermaid
flowchart LR
    Client["Electron / Web client"] <-->|"HTTPS / WebSocket: catalog, history, signaling"| Server["Actix Web server"]
    Server <-->|"Outbound connection: presence, history, signaling"| Daemon["Machine daemon"]
    Client <-->|"WebRTC: operations, terminal, media"| Daemon
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
| Web application | Server-hosted catalog, history, and browser-supported remote access | TypeScript |
| MCP facade | Let agents discover resources and operate on explicit remote targets | TypeScript, sharing deskfleet client operations |

The server owns team membership and shared access policy. Each daemon owns its
machine's workspace configuration, files, processes, and live session state. The
server stores synchronized views so users can browse history while a machine is
offline; clients show when that data was last observed.

The backend is open source in this repository under Apache-2.0. Shared resource
and protocol types remain independent of Actix Web and Node-API.

## Resource model

```text
Team
  Machine
    TerminalSessions [machine scope]
    Workspace
      Ordered directory paths [one or more; first is default]
      Main Worktree [the configured directories]
      AgentSessions
        Managed Worktree [created and removed with the Session]
      TerminalSessions [machine, workspace, or worktree scope]
```

| Resource | Meaning |
| --- | --- |
| Team | Membership and shared access boundary |
| Machine | An enrolled daemon installation and its OS user execution context |
| Workspace | A named, machine-local configuration of one or more ordered directory paths |
| Worktree | The permanent main context or a temporary execution context owned by one Session |
| Directory binding | An unnamed path with a stable position; position zero is the default directory |
| AgentSession | A workspace session with its captured execution context and provider identity |
| TerminalSession | A terminal owned by one Machine, Workspace, or Worktree, with a separate cwd |

A Workspace must be created with at least one existing directory. Its paths are
ordered and have no user-assigned aliases; the first path is the default working
directory. Creating the Workspace also creates exactly one main Worktree in the
same transaction. The main Worktree uses the actual configured directories.
Updating the Workspace changes this main context without retargeting existing
Session contexts.

Worktrees are not independently maintained resources. Each managed Session
allocates its own Worktree automatically; destroying that Session removes its
owned Worktree. For Git-backed contexts, the daemon creates detached Git worktrees
from the configured checkouts' HEAD commits, grouping paths in the same checkout
and preserving subdirectory positions. Uncommitted source changes are not copied.
The first derived path is the Session's default working directory. Workspace
paths may be non-Git for main-context terminals; creating an isolated Session
requires Git-backed paths with a commit.

For example:

```text
Machine: development-box
  Workspace: storefront
    Directories:
      /code/storefront-web  [default]
      /code/storefront-api
    Main Worktree: the two configured directories
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

`deskfleet-migration` owns explicit, reversible schema migrations. Server startup
opens `DATABASE_URL` and applies pending migrations before accepting HTTP
connections. SQLite is the currently enabled and tested backend. The schema uses
portable SeaQuery types and constraints for a later PostgreSQL backend; enabling
that backend will also require connection configuration and PostgreSQL integration
tests. See the [server guide](../../apps/server/README.md) for configuration and
migration commands.

The standalone daemon opens `<daemon directory>/catalog.db` through a thin
`NativeCatalog` napi binding after acquiring its discovery endpoint. `LocalCatalog`
initializes a persistent local Team/Machine context in a transaction and scopes
all operations to that machine. This context enables operation without login;
it does not represent an authenticated account or organization membership.
The local database is independent of the central server database. Enrollment and
synchronization must map catalog identities rather than equate independently
allocated integer IDs.

Authenticated local IPC exposes catalog listing and Workspace create/update/delete,
plus Session create/destroy operations. There are no manual Worktree mutations.
The daemon validates Workspace paths as absolute, existing directories. Committed
changes broadcast `catalogChanged` to authenticated clients. Removing a Workspace
never removes its configured directories from the filesystem.

Session creation allocates a durable Session ID and creates Git worktrees beneath
`<daemon directory>/session-worktrees/<session ID>/`. A manifest records generated
paths for cleanup after restart. Failure rolls back generated checkouts. Explicit
Session destruction removes those disposable checkouts, including their local
changes, before deleting the Session record. It never removes source checkouts.
A daemon/client disconnect alone does not destroy a Session.

The Electron renderer consumes these operations through its narrow preload bridge.
`local-daemon` remains a connection target, distinct from the database Machine ID.
It displays real local resources and supports opening a machine-owned terminal
at a selected binding's path. The working directory does not change terminal
ownership. Accounts, organizations, remote enrollment, central catalog HTTP
operations, daemon synchronization, and agent-session UI are not yet connected.
Daemon terminal transcripts retain their existing storage.

## Daemon and session lifecycle

The daemon runs independently of Electron, normally as the OS user whose files,
credentials, and tools the agents use. Closing the app or losing a connection
must leave ongoing work running. Local clients connect over authenticated IPC,
such as a Unix-domain socket or Windows named pipe.

Desktop Settings has a persistent **Run local Agent** preference, enabled by
default. The client consumes `@deskfleet/daemon` as a library bundled into the
application. It starts a detached instance of its own Electron executable in a
daemon-only host mode, using the bundled native addon and runtime. This process
has no UI or client single-instance lock and has a separate Chromium profile.
The standalone Node.js SEA remains the headless distribution of the same daemon.

Startup reuses an authenticated daemon already owning the discovery directory.
Explicitly disabling the preference sends authenticated shutdown and waits for
the discovery lease to be released after cleanup. It ends live terminal processes
but retains catalog and terminal history. Client exit only detaches, leaving the
daemon alive. Disabling auto-start does not kill an independently started daemon
when a client next launches. Startup/shutdown errors and retries appear in Settings.

The desktop client stays resident in the system tray (the macOS menu bar or the
Windows notification area). Closing its window or using an ordinary quit command
hides it. The tray menu, OS session end, or a termination signal exits the client
process.

The daemon is the ACP client and owns local agent processes or adapter
connections. Each AgentSession belongs to a Workspace and captures its Worktree execution
context at startup; later edits to the Workspace must not silently retarget a
running session. Additional directories are exposed through the provider's
supported configuration or tools.

The first provider connects Codex CLI through the bundled
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp). The shared
`AgentProvider` interface accepts a user-facing name, an optional binary path,
and environment overrides. Provider-specific code selects the process; the
[ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) handles
initialization, session creation, prompts, cancellation, and session updates.
Codex uses the installed CLI and its credentials. The adapter runs as a child
process; the SEA executable reuses its bundled Node runtime. The desktop daemon
injects an adapter launch using its own Electron executable and an ACP-only app
entry point. This entry loads the bundled adapter without the client UI or daemon
services and works with Electron's RunAsNode fuse disabled. A Node worker owns
the adapter's event loop so its Codex subprocess finishes closing before the
Electron host exits. Source TypeScript
entry paths are used only by the standalone development daemon.

The desktop composer discovers model and reasoning choices through the local
daemon's `agentConfiguration` request. The daemon resolves the selected Worktree's
first directory from its catalog, or uses the home directory before a target is
selected. Each discovery creates a temporary ACP session, reads the provider's
configuration selectors, applies draft selections in model-then-reasoning order,
and closes the provider process. It sends no prompt and allocates no managed
Session or Worktree. Discovery times out after 45 seconds and is cancelled when
the requesting client disconnects. These selections configure a draft; updating
running AgentSessions belongs to the future session API. The renderer saves draft
choices per device. Discovery uses a separate IPC connection so agent startup
does not delay terminal operations or catalog refreshes.

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
Claude Code, Pi, and Cursor CLI are further integration candidates. Managed
sessions, imported history, resumed sessions, and attachment to an existing CLI
process are distinct capabilities. ACP alone does not guarantee live attachment;
a tmux connection can expose the CLI without providing structured ACP control.

Agent events feed deskfleet's session view and stored history. Preserve the
provider's session identifier and relevant provider metadata alongside the
common conversation, tool, approval, and state events. Credentials remain on the
executing machine. ACP approval callbacks do not confine agents that execute
tools directly.

Reconnecting clients attach to the current session without resubmitting prompts.
Multiple observers must not produce conflicting control or approval responses;
the control policy will be defined with the session API. Disconnect never grants
approval.

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
| Presence, history synchronization, and WebRTC signaling | Authenticated WebSocket or HTTPS streams |
| Terminal dial, hangup, catalog and lifecycle events | Authenticated signaling; IPC for the local client |
| Interactive operations, Git queries, terminal I/O and resize | WebRTC DataChannel |
| Desktop video/audio | WebRTC media tracks |
| Desktop input | WebRTC DataChannel |
| Local client operations | Authenticated IPC |

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

Electron terminals use a data-only peer on the same signaling infrastructure.
The daemon owns native PTYs independently of their viewers; disconnect detaches,
and an existing terminal can be listed and reattached without restarting its
shell. The UI supports local machine-scoped terminals. See
[terminal integration](terminals.md) for dial/hangup, durable history, and flow
control.

Git inspection starts with the Git CLI's machine-readable output. Resolve each
directory to its checkout and retrieve branch, HEAD, status, and diffs. Query a
shared checkout once when several bindings point to it. Non-Git directories stay
usable in the main context. Session provisioning creates and removes managed Git
worktrees; Git status/diff UI and live inspection remain to be connected.

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
complete recording. Catalog persistence uses SQLite through SeaORM; the history
event format and replay mechanism remain to be defined when implementing history
persistence.

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

Remote access needs an expiry and revocation policy that also works during
control-plane outages. Local work follows the machine's execution policy;
revoking a client's access and cancelling a running task are separate actions.
Define grant lifetimes and renewal behavior with enrollment and authentication.

The initial design trusts the server with synchronized history. Keep machine
private keys and application credentials out of history and logs. Define
retention and deletion when adding storage. Electron renderers stay sandboxed,
with narrow preload interfaces; agent output and repository content are
untrusted display data.

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
| `deskfleet-native` | Native capabilities independent of Node.js |
| `deskfleet-capture` | Native display capture and retained GPU surfaces |
| `deskfleet-encoder` | VideoToolbox/NVENC video encoding and Opus audio encoding |
| `deskfleet-nvenc` | Windows NVENC session and D3D11 resource ownership |
| `deskfleet-nvenc-sys` | Windows NVENC FFI and runtime driver loading |
| `deskfleet-node` | napi-rs wrapper over native capabilities |
| `deskfleet-server` | Actix Web application in `apps/server` |

Dependencies flow `server -> protocol -> model`, `server -> store -> model/migration`,
`node -> store -> model/migration` for local catalog persistence,
`node -> native -> capture/encoder`, and
`@deskfleet/daemon -> @deskfleet/native`. The pnpm workspace currently contains
the daemon, the desktop client, and the native package. TypeScript wire types
should derive from the same authoritative contracts as Rust; napi declarations
describe the native API separately.

`PROTOCOL_VERSION` stays at `1` until the first freeze is explicitly declared.
Contracts evolve in place, including incompatible changes. Do not add version
bump tasks or compatibility layers for earlier provisional shapes.

mise manages tools and tasks with lockfile mode enabled. APM owns the checked-in
skills. See the [development environment](environment.md), [CI workflow](ci.md),
and [agent guide](../../AGENTS.md) for repository conventions.

## Next milestone

Daemon/native packaging and the first ACP provider are implemented. Next add a
second ACP provider and authenticated WebRTC with direct and TURN-relayed terminal
access.

Then complete one workflow: enroll a headless machine, register a workspace and
a worktree spanning frontend/backend directories, run an agent, inspect its Git
state from another machine, and open terminals at each supported scope. Work
continues after closing the client, reconnecting restores the session view, and
synchronized history remains available while the machine is offline.

MCP coordination and desktop control follow that workflow. Remaining choices
include provider distribution, terminal backends, Linux capture/encoding,
authenticated signaling, and session history persistence.

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
