# deskfleet daemon

`@deskfleet/daemon` is a TypeScript library, hosted inside Electron's main process
or packaged as a standalone SEA executable for headless machines. It owns local
Workspace configuration, ACP providers, Session execution, terminals, native
WebRTC, and the authoritative SQLite journal. The central backend authorizes
management operations and stores queryable catalog/history replicas. The daemon's
[file service](../../agents/docs/files.md) serves authorized file transfers and
Agent Markdown resources over an independent files WebRTC peer.

## Development and enrollment

From the repository root:

```sh
mise run daemon:dev
```

This builds the addon and starts a loopback health listener. A ready event prints
its address; `GET /healthz` reports the loaded native version and platform.
`--port 8081` selects a port, and `--info` prints native/runtime information and
exits. Configure PostgreSQL and OIDC through the [server guide](../server/README.md).
Both Electron and Web require login and Team selection before resource creation.

Electron can enroll the daemon it hosts. For a headless machine, first start its
daemon, then inspect its installation identity:

```sh
mise exec -- node apps/daemon/src/main.ts status
```

In either client, choose Add machine → Another machine and paste that output.
The client reads the installation `originId` and local `machineId` from it and
displays the new machine credential once. Save that JSON privately or paste it
on stdin:

```sh
mise exec -- node apps/daemon/src/main.ts enroll --server-url https://backend.example < machine-credentials.json
```

The JSON contains `machineId` (the central machine ID), `teamId`, and `token`.
Enrollment verifies the credential and its installation identity with the
backend before persisting it. The credential never appears in command-line
arguments or status output. HTTPS is required except for loopback development.

Administrator removal logs the machine out and makes `status.revoked` true.
Existing execution continues until shutdown or an explicit new registration.
To register it again, first prepare a new empty machine directory:

```sh
deskfleet-daemon prepare-enrollment
```

This stops the old Agent and terminal processes, retains their data at its
original paths, and prints a fresh identity. Paste that output into the Add
machine dialog, then import the new credential. It can join the original Team or another
Team. Electron performs this preparation when enrolling a removed local machine.
An active registration cannot be overwritten. Old history, Provider settings,
and Workspaces are not imported into the new registration.

The daemon publishes a private Unix socket or Windows named pipe through
`~/.deskfleet/daemon.json`. `DESKFLEET_DAEMON_DIRECTORY` selects another directory.
Only one live daemon can own it. The discovery token permits host setup,
enrollment, capabilities, and shutdown; it does not grant resource access.
Production resource operations go through the backend's authenticated APIs.
Local control is available only to explicit in-process test fixtures.

## Storage and process ownership

The first production machine uses `<daemon directory>/machine/`. A subsequent
registration uses a fresh `machines/<uuid>/` directory, selected by the host's
`active-machine.json`. Every machine directory contains:

- `central.json`: private machine registration and credential.
- `catalog.db`: SQLite Workspace/Session ownership, conversation, and audit.
- `agent-providers.json`: machine-local provider launch settings and environment.
- `session-worktrees/`: ownership manifests and, by default, generated Session checkouts.
- `terminals/`: terminal metadata and full output transcripts.

Earlier unauthenticated development data outside this namespace is not imported.
Retired directories stay in place because Git worktrees and saved working
directories contain absolute paths. A reset never renames or deletes them.
Local integer IDs remain decimal strings and are qualified by the catalog origin
and central machine identity. Equal IDs on different machines stay distinct.

Desktop Settings → Preferences → This computer includes **Worktree root directory**
for placing new Session checkouts on another disk. The preference is stored in
`<daemon directory>/worktree-settings.json` as `{ "root": "/absolute/path" }`;
headless installations can write the same file. Use `{ "root": null }` or remove
the file to restore the default. The chosen directory must exist when creating a
Session; an unavailable root fails creation instead of using the default disk.
Desktop Settings creates the selected directory when saving it.

The running daemon reads this setting for each new worktree Session, including
when Electron reuses a standalone daemon. Custom checkouts live under
`<root>/<catalog origin>/<session ID>/`, keeping different machine registrations
separate. Changing or resetting the root does not move existing checkouts or
affect Sessions using Workspace directories directly. Ownership manifests stay
in the machine directory and record each custom checkout location so rollback
and internal destruction keep working after a settings change or restart.

The daemon connects outbound to the central control WebSocket. Workspace,
Provider, Session archive/restore, directory browsing, and terminal lifecycle
requests carry a server-verified actor. Peer authorization has an independent
lifetime: a working peer survives signaling loss until closure, revocation, or
its 24-hour deadline. Closing a viewer does not stop Agents or PTYs. History
synchronization replays durable events and command receipts after reconnect;
terminal bytes and desktop media are not synchronized centrally.

On macOS standalone creation requests Full Disk Access, screen/system-audio access, and
Accessibility without blocking other operations. Full Disk Access is checked
in the hosting process; when missing, the daemon opens System Settings → Privacy
& Security → Full Disk Access and reports instructions to stderr. Enable the
hosting app or executable there and restart it. Apple requires this manual step;
the daemon cannot grant itself permission. The check infers access by opening a
protected TCC database without reading its contents; unexpected probe failures
remain errors. Other platforms require no upfront Full Disk Access request.
Denial does not stop the daemon; protected file operations retain OS enforcement.
Capture initializes on demand; see [media permissions](../../agents/docs/media.md).
Data-only Agent and terminal
peers do not require capture permission.

Electron passes `permissionMode: "guided"` when creating the daemon. This checks
all three permissions without showing OS dialogs. Its welcome page invokes the
authenticated local `permissionRequest` operation for one permission at a time;
`permissionsRefresh` rechecks status after the user returns from System Settings.
Pending requests do not block IPC or shutdown, and repeated requests for a
pending permission share that request. The native checks and dialogs always run
in the daemon's hosting process, including when Electron reuses a standalone
daemon. These operations grant no Team or machine-resource authority.

The library exports `startDaemon()`, `close()`, and a `closed` promise. Importing
it does not launch the CLI. Electron hosts the daemon in its main process and
closes windows to the tray; quitting the application stops its daemon. Standalone
SEA installations run independently. SIGINT/SIGTERM close listeners, providers,
peers, and PTYs, preserve history, and release discovery after cleanup.

## Workspace and Session management

Backend machine RPC authorizes `catalogList`, `directoryList`,
`workspaceCreate`, `workspaceUpdate`, and `workspaceDelete`. Workspace creation
requires ordered, unique, absolute directory paths. The first is the default;
there are no aliases or independently managed Worktrees. A Workspace's main
Worktree uses its actual directories. Session creation chooses either generated
Git worktrees or the original directories. Directory browsing always runs on the
target daemon, using that machine's path rules.

Archive retains Session-owned worktrees, including uncommitted and untracked
files. Archived Sessions still own their Workspace and block its deletion.
Workspace deletion leaves the configured source directories intact.
See [Agent Sessions](../../agents/docs/agent-sessions.md) and
[terminals](../../agents/docs/terminals.md) for persistence and lifecycle details.

## Agents through ACP

The daemon connects installed CLIs to ACP through the
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp),
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp),
and [Pi ACP adapter](https://github.com/svkozak/pi-acp). These are pinned pnpm
dependencies and ship inside the SEA executable. Install and authenticate the
CLI before sending prompts; the daemon uses that CLI's credentials.

The desktop **New session** flow creates a persistent Session and its isolated
Git Worktree. Its conversation, queued inputs, runs, approval decisions, and
command audit are stored in the same SQLite catalog. Closing a client leaves
execution running; reopening replays the journal over the `deskfleet-acp`
DataChannel. The composer can queue a message or steer the current turn, and a
pending candidate can also be selected for steering. Stop retains the backlog;
the next message, or an explicit `session/resume`, reuses the saved provider
conversation. Archive stops the provider and Session-owned terminals while preserving all files,
conversation history, audit, queued inputs, and terminal transcripts. Restore
returns the same Session to active use without starting processes. Permanent
Session deletion is unavailable through user-facing APIs or clients.

The backend authenticates and binds SDP to a user, login session, Team, target
machine, and 24-hour peer grant. Conversation operations use the DataChannel
extensions documented in [Agent Sessions](../../agents/docs/agent-sessions.md).
The daemon records the verified actor supplied by the grant.

Run `mise run desktop:smoke-agent` to verify the production Electron flow with
real WebRTC, SQLite, and Git worktrees using a scripted provider and no paid
inference. The one-shot CLI below remains useful independently of persistent
desktop Sessions.

After `mise run install`, check ACP initialization or run one prompt from source:

```sh
mise exec -- node apps/daemon/src/main.ts agent codex --check
mise exec -- node apps/daemon/src/main.ts agent codex --cwd /path/to/repository --prompt 'Explain this repository'
mise exec -- node apps/daemon/src/main.ts agent claude-code --check
mise exec -- node apps/daemon/src/main.ts agent cursor --check
mise exec -- node apps/daemon/src/main.ts agent grok --check
mise exec -- node apps/daemon/src/main.ts agent pi --check
```

`--check` initializes ACP and exits without creating a session or sending a
prompt. A prompt invocation creates one ACP session, prints newline-delimited
JSON events for initialization, session creation, updates, and the stop reason,
then closes the connection. On Unix, SIGINT cancels the active prompt.

Agent configuration uses these common options:

| Option | Meaning |
| --- | --- |
| `--name <label>` | User-facing label, defaulting to `Codex`, `Claude Code`, `Cursor`, `Grok`, or `Pi Coding Agent`, separate from the provider ID |
| `--binary-path <executable>` | CLI executable; omitted or empty uses `codex`, `claude`, `agent`, `grok`, or `pi` on PATH |
| `--env KEY=value` | Add or override an environment variable; repeat for multiple keys |

The selected binary path takes precedence over `CODEX_PATH` or
`CLAUDE_CODE_EXECUTABLE` in the environment, so the Claude adapter never falls
back to the SDK's optional bundled binary. Cursor is not an adapter: the daemon
runs `` `<binary> acp` `` and then `authenticate` with `cursor_login` when that method
is advertised. `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` are ordinary environment
overrides; root CLI flags, if required, belong before the `acp` argument and are
not added by deskfleet. Cursor continues a saved conversation with `session/load`.
Grok is also native ACP: the daemon runs `` `<binary> agent stdio` ``. It then
calls `authenticate` with `xai.api_key` when `XAI_API_KEY` is set and advertised,
and otherwise with `cached_token`. `grok login` caches that token. Interactive
methods are left unused, and `--always-approve` is not added, so permission
requests reach the client. When the caller accepts questions, `cursor/ask_question`,
`x.ai/ask_user_question`, and `_x.ai/ask_user_question` are answered through that
form. `cursor/create_plan` and Cursor's notification methods stay unrecognized.
Pi uses the bundled `pi-acp` bridge to run `` `<binary> --mode rpc` ``; the
selected path overrides `PI_ACP_PI_COMMAND`. It supports saved-session loading
and model/thinking configuration. Pi executes tools locally, and the bridge does
not forward client-provided MCP servers or additional Workspace directories.
Settings installs Pi with the official `pi.dev` installer. For login, start `pi`,
enter `/login`, then `/quit` when setup is complete. Executable discovery leaves
its credential status unknown; **Test Connection** opens a session using existing
credentials.
`--cwd` sets an unmanaged ACP session's working directory and defaults to the
current directory. This one-shot development helper does not create a team
Session. Use the authenticated Web or Electron client for persistent Sessions;
the former `--workspace-id` local development path is unavailable in the CLI.

The CLI cancels permission requests and emits `permission_cancelled` events.
It has no approval UI; prompts requiring approval cannot proceed through it.

The pinned adapter uses
[`patches/@agentclientprotocol__codex-acp@2.2.2.patch`](../../patches/@agentclientprotocol__codex-acp@2.2.2.patch).
It makes steering return `promptRequired` when the target turn ends, allowing the
daemon to start and track the next prompt. It also clears the app-server shutdown
timers after the child exits, so configuration discovery does not wait through an
unused two-second grace period. The termination deadlines still apply to a child
that has not exited. See the
[steering contract](../../agents/docs/agent-sessions.md#codex-steering-boundary)
for capability negotiation and delivery semantics. Remove each patch hunk when
the pinned adapter provides its corresponding behavior upstream.

The Pi adapter is pinned to `0.0.34` with
[`patches/pi-acp@0.0.34.patch`](../../patches/pi-acp@0.0.34.patch). The patch reuses
its static `spawnSync` import instead of top-level await so it can be bundled for
SEA, and imports its package metadata statically to preserve its identity in
bundles. It also retains the agent handler directly so closing the adapter
terminates its Pi subprocesses; the upstream shutdown code accesses a handler
that the ACP SDK does not expose.

Source and SEA launches route adapter subprocesses through `--codex-acp`,
`--claude-agent-acp`, or `--pi-acp` on their own entry point. The Claude adapter's published
entry uses top-level await, which the CommonJS SEA bundle cannot contain, so
`--claude-agent-acp` starts its exported stdio server directly. The Electron daemon configures its bundled main entry as the
adapter host and starts it with `ELECTRON_RUN_AS_NODE=1`, including from ASAR.
That entry routes to the bundled adapter before loading Electron UI or daemon
lifecycle code. Adapter processes use the same installed binary selection and
can terminate naturally when their ACP input closes.

The packaged executable accepts the same arguments:

```sh
./apps/daemon/dist/deskfleet-daemon agent codex --check
```

## Standalone executable

```sh
mise run build
mise run daemon:smoke
```

The build embeds JavaScript and the native addon in
`apps/daemon/dist/deskfleet-daemon` (`deskfleet-daemon.exe` on Windows). This file
runs by itself without a Node installation or adjacent addon:

```sh
./apps/daemon/dist/deskfleet-daemon --info
./apps/daemon/dist/deskfleet-daemon --port 8081
```

Use `mise run daemon:pack` to build just the standalone daemon.

Packaging uses the mise-selected Node executable, esbuild, and postject. macOS
builds receive an ad-hoc signature; release signing and notarization are not
configured.

The native addon is extracted into a private temporary directory before loading.
Unix removes it after loading. Windows attempts removal on exit, but mapped DLLs
may remain until the temporary directory is cleaned.

Supported platforms are Linux x64/arm64, macOS arm64, and Windows x64. See the
[CI guide](../../agents/docs/ci.md) for build artifacts and smoke tests.
