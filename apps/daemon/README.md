# deskfleet daemon

`@deskfleet/daemon` is a TypeScript library. It runs as a standalone SEA process
on headless machines or inside the desktop app's main process. It reports
native platform information, serves a loopback health
endpoint, owns a persistent workspace/worktree catalog, and runs Codex CLI and
Claude Code sessions over ACP.

Its programmatic `PeerSessions` API owns native WebRTC peers and optional desktop
streams; daemon shutdown closes these sessions. The CLI exposes authenticated
local IPC for Electron capability discovery, WebRTC signaling, and capture
control. Central server signaling is not yet connected. See [native media](../../agents/docs/media.md) for the API,
platform support, and codec details.

## Development

From the repository root:

```sh
mise run daemon:dev
```

This builds the debug addon and starts the TypeScript entry point. The daemon
binds `127.0.0.1` on an available port and prints one ready event:

```json
{"event":"ready","address":"http://127.0.0.1:49152"}
```

`GET /healthz` returns `status: "ok"` and the Rust addon's `version`, `os`, and
`arch` under `native`.

Use `--port 8081` to select a port. `--info` prints native information plus the
Node runtime version and whether the process is a SEA, then exits. For example,
after the debug build:

```sh
mise exec -- node apps/daemon/src/main.ts --info
mise exec -- node apps/daemon/src/main.ts --port 8081
```

The CLI publishes its authenticated Unix socket or Windows named pipe in
`~/.deskfleet/daemon.json` (private directory and file). Set
`DESKFLEET_DAEMON_DIRECTORY` to use another directory, with the same value in the
Electron environment. Only one daemon can publish a live endpoint there. Local
IPC initializes capture only when the client requests capabilities or a stream.
On macOS, startup first requests screen/system-audio recording permission from
the daemon process, without waiting for consent before serving other operations.
The authenticated handshake and permission events report its status to Settings;
denial does not stop the daemon. See [media permissions](../../agents/docs/media.md).
Losing a client closes its peers, leaving the daemon, agent work, and terminal
processes alive. The data-only terminal peer uses the same authenticated signaling
path. Dial, hangup, catalog and lifecycle events use signaling; terminal bytes
and resize travel on its WebRTC DataChannel. `TerminalSessions` owns native PTYs
and their full disk-backed output history. History lives in the daemon directory
until explicit hangup. Restart preserves history and marks lost processes
interrupted. See [terminals](../../agents/docs/terminals.md).

On Unix, SIGINT and SIGTERM close the listeners, database, media sessions, and PTYs, remove the
discovery record, and exit cleanly.

The package root exports `startDaemon()`, returning `close()` and a `closed`
promise that settles after cleanup. Importing the library does not launch the
CLI. The `control-client` and `control-discovery` subpaths let clients connect
without loading native daemon implementation modules. Authenticated `shutdown`
acknowledges the request, stops new work, and closes resources before releasing
discovery. Unauthenticated clients cannot request shutdown.

Desktop Settings starts this library in the app's main process by default, and
quitting the app stops it. Its runtime and native addon ship with the desktop
application; the standalone SEA runs independently for headless installations. Both hosts share
the same discovery, catalog, and terminal storage. See the
[desktop guide](../desktop/README.md#local-agent) for the toggle and lifecycle.

## Local workspace catalog

The daemon stores workspaces, worktrees, and ordered directory bindings in
`<daemon directory>/catalog.db`, using SeaORM through the Rust addon. Migrations
and a local Team/Machine context initialize only after the daemon owns discovery.
That context persists across restarts and enables standalone use without an
account or organization. It is separate from the central server's database.

The authenticated IPC connection supports these methods:

| Method | Parameters | Result |
| --- | --- | --- |
| `catalogList` | none | Local context and all workspaces/worktrees |
| `directoryList` | optional absolute `path` (defaults to daemon home) | Current path, parent, home, roots, and child directories |
| `workspaceCreate` | `name`, `directories` | Workspace with its automatic main Worktree |
| `workspaceUpdate` | `workspaceId`, `name`, `directories` | Workspace with its updated main context |
| `workspaceDelete` | `workspaceId` | Empty result; rejects active Sessions |
| `workspaceSessionCreate` | `workspaceId` | Session ID, Workspace ID, and its generated Worktree |
| `workspaceSessionDestroy` | `sessionId` | Empty result after removing the Session's disposable checkouts |

`catalog-protocol.ts` reuses DTOs generated from the Rust binding. IDs remain
decimal strings, including values above JavaScript's safe integer range.
Each directory contains only `path`. Creating or updating a Workspace requires at
least one unique absolute existing directory. Order is preserved and the first
path is the default. Workspace creation atomically creates its permanent main
Worktree from these paths. There are no independent Worktree mutation methods.
Deleting a Workspace leaves its configured source directories on disk. Successful mutations broadcast `catalogChanged` to
authenticated clients. Unauthenticated clients cannot read, mutate, or observe
the catalog.

Electron exposes Workspace operations as `window.deskfleet.catalog` through the
existing authenticated connection. Worktrees are read-only contexts in the UI.
The folder picker uses `window.deskfleet.filesystem.listDirectories` on that
connection. Directory enumeration and path handling run on the daemon; the
renderer uses returned paths without applying its own operating system's rules.
Managed Session creation derives detached Git worktrees from committed HEADs and
maps each directory, including subdirectories, into them. Session destruction
removes those generated checkouts (including local changes) and their catalog
record. Ownership manifests beneath `session-worktrees/` allow explicit cleanup
after daemon restart. Source checkouts are never removed. Non-Git directories
remain usable in the main context; isolated Sessions require Git-backed paths.
 Catalog data survives closing Electron and restarting
the daemon. Local IDs belong to this database; future enrollment/synchronization
must not merge them with independent databases by integer equality.

## Agents through ACP

The daemon uses the [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
to connect the installed Codex CLI to ACP, and the
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
to connect the installed Claude Code CLI. Both adapters are pinned pnpm
dependencies and ship inside the SEA executable. Install and authenticate the
CLI before sending prompts; the daemon uses that CLI's credentials.

The desktop **New session** flow creates a persistent Session and its isolated
Git Worktree. Its conversation, queued inputs, runs, approval decisions, and
command audit are stored in the same SQLite catalog. Closing a client leaves
execution running; reopening replays the journal over the `deskfleet-acp`
DataChannel. The composer can queue a message or steer the current turn, and a
pending candidate can also be selected for steering. Stop retains the backlog;
the next message, or an explicit `session/resume`, reuses the saved provider
conversation. Explicit deletion removes the owned
checkouts and history while retaining command audit.

Local IPC adds `agentOffer` for SDP/ICE signaling only. Conversation operations
use the DataChannel extensions documented in
[Agent Sessions](../../agents/docs/agent-sessions.md). Local token identity is
audited today; remote account enrollment is separate work.

Run `mise run desktop:smoke-agent` to verify the production Electron flow with
real WebRTC, SQLite, and Git worktrees using a scripted provider and no paid
inference. The one-shot CLI below remains useful independently of persistent
desktop Sessions.

After `mise run install`, check ACP initialization or run one prompt from source:

```sh
mise exec -- node apps/daemon/src/main.ts agent codex --check
mise exec -- node apps/daemon/src/main.ts agent codex --cwd /path/to/repository --prompt 'Explain this repository'
# With the daemon running and a Git-backed Workspace already configured:
mise exec -- node apps/daemon/src/main.ts agent codex --workspace-id 1 --prompt 'Explain this repository'
mise exec -- node apps/daemon/src/main.ts agent claude-code --check
mise exec -- node apps/daemon/src/main.ts agent cursor --check
mise exec -- node apps/daemon/src/main.ts agent grok --check
```

`--check` initializes ACP and exits without creating a session or sending a
prompt. A prompt invocation creates one ACP session, prints newline-delimited
JSON events for initialization, session creation, updates, and the stop reason,
then closes the connection. On Unix, SIGINT cancels the active prompt.

Agent configuration uses these common options:

| Option | Meaning |
| --- | --- |
| `--name <label>` | User-facing label, defaulting to `Codex`, `Claude Code`, `Cursor`, or `Grok`, separate from the provider ID |
| `--binary-path <executable>` | CLI executable; omitted or empty uses `codex`, `claude`, `agent`, or `grok` on PATH |
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
`--cwd` sets an unmanaged ACP session's working directory and defaults to the
current directory. `--workspace-id` instead allocates a managed Session through
the running daemon; these flags are mutually exclusive. It uses the generated
Worktree's first directory as cwd and destroys that Session after the provider
process closes, including initialization or prompt failure. The provider's
`sessionId` remains distinct from the bigint database Session ID. Closing the
Electron client does not destroy the Session.

The CLI cancels permission requests and emits `permission_cancelled` events.
It has no approval UI; prompts requiring approval cannot proceed through it.

The pinned adapter uses
[`patches/@agentclientprotocol__codex-acp@2.2.2.patch`](../../patches/@agentclientprotocol__codex-acp@2.2.2.patch).
It makes steering return `promptRequired` when the target turn ends, allowing the
daemon to start and track the next prompt. See the
[steering contract](../../agents/docs/agent-sessions.md#codex-steering-boundary)
for capability negotiation and delivery semantics. Remove the patch when the
pinned adapter provides that contract upstream.

Source and SEA launches route adapter subprocesses through `--codex-acp` or
`--claude-agent-acp` on their own entry point. The Claude adapter's published
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
