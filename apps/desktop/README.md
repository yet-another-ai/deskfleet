# deskfleet desktop

`@deskfleet/desktop` is the Electron client for the machine daemon, which it hosts
in its main process. Closing the window leaves the app in the tray with the daemon
and its agent sessions running; quitting the app stops them. The renderer uses Vue
with vue-router, Pinia, VueUse, vue-i18n, UnoCSS, Lucide icons, and xterm.js.

## Development

From the repository root:

```sh
mise run desktop:dev
```

`scripts/dev.ts` serves the renderer from Vite at `http://127.0.0.1:5173/` with
hot reload and rebuilds the main and preload bundles in watch mode. It restarts
Electron when either bundle changes. Quitting from the tray menu or pressing
Ctrl-C stops the watchers.

Each dev restart quits Electron, which stops the hosted local Agent and starts it
again with the rebuilt daemon code. This stops live terminals and agent runs;
saved catalog, conversation, and terminal history remain.

`mise run desktop:build` writes the production bundles to `out/`. Run them with
`mise exec -- pnpm --filter @deskfleet/desktop exec electron .`. Electron
downloads its platform binary the first time it is resolved.

## Layout

| Path | Process | Bundle |
| --- | --- | --- |
| `src/main` | Electron main process | `out/main/index.js` (ESM) |
| `src/preload` | Sandboxed preload | `out/preload/index.cjs` (CommonJS) |
| `src/renderer` | Renderer bootstrap | `out/renderer` |
| `src/shared` | Code imported by more than one process | Inlined into each bundle |
| `packages/components` | Shared Vue UI and locale catalogs for desktop and web | Inlined into renderer |
| `packages/client` | Platform contracts and remote transport | Inlined into host bundles |
| `build` | Packaging input and runtime window and tray images | Selected files in `app.asar` |

Each process has its own Vite configuration (`vite.main.config.ts`,
`vite.preload.config.ts`, and `vite.renderer.config.ts`).

## Interface layout

The production client signs in to a configured backend through OIDC and selects
a team and an enrolled machine. The Electron main process owns account HTTP and
WebSocket connections and stores the application token using Electron safeStorage.
A narrow preload adapter exposes operations and events without exposing that token
to the renderer. The browser callback uses a temporary loopback listener and a
client verifier bound to the one-time login code.

The common UI in `packages/components` browses synchronized catalogs and history.
Team selection, member administration, invitation codes, and machine enrollment
are shared with the independently deployed Web application. A Team menu sits at
the top of the sidebar. The selected machine's workspace tree appears below it;
the Team's other machines appear as collapsed groups, and opening one switches
to it. Team creation/joining and Add machine open focused dialogs. Team settings,
alongside Preferences and Agents, manages the name, members and roles, and
machines. It remains available while a Team has no machines. The account menu
and sign-out action live in the sidebar footer.
Add machine offers this computer on the desktop, which enrolls its hosted daemon;
an existing enrollment is never silently reassigned. For another machine, paste
the output of `deskfleet-daemon status` into the dialog and import the issued
credential on that machine. Either path names the machine for the Team, starting
from its hostname; any member can rename it later in Team settings, and every
client shows that name in place of the hostname.
After administrator removal, local enrollment first stops the retired execution
context and prepares a new empty directory and identity. The previous data stays
at its original paths; the new registration can join the same Team again.

Workspace creation and editing use the target daemon's filesystem browser through
central management APIs.
Management uses authenticated HTTP; live Agent, Git, terminal, and desktop traffic
uses an authorized WebRTC peer with server-provided STUN/TURN settings. Offline
machines retain their synchronized catalog and readable conversation history.
Catalog loading indicators describe the first snapshot for the selected machine.
Background catalog and presence updates preserve the existing workspace tree,
selection, and content while refreshing; failures still expose their error and
disable unavailable operations.

The selected machine has its own application state. Switching machines disposes
that view's peers and caches without stopping the remote agents or terminals.
Peer authorization expires independently of signaling: a server disconnection
alone does not close established DataChannels, while revocation and the grant's
24-hour deadline do.

The window is frameless and has three columns. The sidebar holds the window
toolbar (sidebar toggle, back, forward), the New session action, the resource
tree, and the Team and machine selectors. The main pane shows the routed view under a header row
that takes over the toolbar while the sidebar is hidden. The details panel on the
right describes the current route's resource; its header toggle and its tab
persist per device. The macOS traffic lights sit in the sidebar's toolbar row.
The Windows and Linux controls overlay the window's top-right corner, which the
rightmost header reserves with `.titlebar-overlay-inset`
(`src/main/window-chrome.ts`).

The tree follows the resource model: machines contain workspaces, and workspaces
list their Sessions. Each Session exposes its associated Worktree. Machine terminals
appear under the machine; a Session's terminals stay in its bottom panel. Machines with a
graphical session list Remote desktop first; headless machines omit it. Offline
machines start collapsed and report when they were last seen.

| Route | View |
| --- | --- |
| `/` | New session: a composer targeting a machine, workspace, and provider |
| `/workspaces/:workspaceId` | Workspace name, ordered directories, Sessions, default-directory terminal, and deletion |
| `/worktrees/:worktreeId` | Directory bindings and the owning Session of a session Worktree |
| `/sessions/:sessionId` | Conversation, tools, permissions, candidate backlog, composer, and agent lifecycle |
| `/terminals/:terminalId` | A machine terminal's tab; a Session terminal redirects to its Session's panel |
| `/machines/:machineId/terminals` | Terminal tabs and the empty terminal workspace |
| `/machines/:machineId/desktop` | A machine's remote desktop surface, or why it is unavailable |
| `/settings/preferences` | Preferences, including launch at startup and the local Agent under This computer |

A Workspace page's New session action makes that Workspace the composer's target.
Worktree links and lookups only resolve Session-owned contexts.

Settings routes (`meta.fullWindow`) replace the sidebar and details panel with
two panels: the sections on the left and the selected section on the right.
Section links replace their history entry, so **Back to app** or Escape returns
to the page Settings opened from. **Preferences → This computer** contains
**Launch at startup** alongside the local Agent startup preference, run state,
and retry.

The details panel has two tabs:

- **Details** lists the resource's owner and properties: a session's provider, a
  terminal's scope and cwd, or a machine's display. Workspace details show its
  configured directories; Session and Worktree details show the Session's paths
  with each checkout's branch and HEAD when available.
- **Changes** inspects the Session's actual directories on the local daemon,
  grouping files by checkout and staged, unstaged, or untracked state, with
  status letters and line counts. Select a file to open a diff preview. Both
  the list and the open diff refresh automatically every 1.5 seconds after the
  previous read, including changes made outside the agent. Closing the tab or
  hiding the window pauses refreshes. Non-Git directories, binary files, large
  truncated diffs, and read errors have explicit states. It is empty for
  machine and workspace terminals and for desktops, which belong to no worktree.

`useRouteResource` resolves the route to that resource. The new session page
describes its target Workspace.

## Agent sessions

Settings → Agents manages the machine's configured providers, including their
names, icons, executable paths, and environment overrides. The Codex and Claude
Code templates use their installed and authenticated CLIs through bundled ACP adapters.
The Cursor template runs the installed Cursor CLI as `agent acp`.
The Grok template runs the installed Grok CLI as `grok agent stdio`.
Their multiple-choice questions use the session question cards.
The ACP template runs a configured ACP executable directly. **New session**
creates a persistent Session for the selected Workspace and provider, then submits the prompt.
The composer's context menu chooses **New worktree**, isolated Git checkouts from
each directory's committed HEAD, or **Working directory**, which works in the
Workspace's directories with their uncommitted changes. The last choice is
remembered. Provisioning failures remain visible with their error and can be
archived; they do not expose a usable Worktree.

Click the Agent summary in the composer to open a menu with Agent, Model, and
Reasoning rows. Each row opens a submenu of choices with the current choice
checked. The Agent submenu selects a configured provider for a new Session;
model and effort choices come from that provider's ACP configuration options.
New-session selections are
remembered on the device and applied before the first prompt. In an existing
Session, the menu reads and updates that Session's provider configuration.
Model changes refresh the available reasoning choices. Failed requests keep the
confirmed selection visible and offer a retry.
If a saved model or reasoning effort becomes unavailable, the menu offers valid
alternatives so the Session can be recovered without deleting its conversation.

The conversation shows streamed text, tool calls, plans, and permission requests.
Messages submitted during a turn enter the shared candidate backlog. **Steer now**
can send a new message or a selected candidate to the active turn when the provider
supports it. Pending candidates can be withdrawn; confirmed delivery failures can
be retried. Uncertain delivery requires checking the recorded result before
submitting again. The UI displays each input's author and source machine, plus the
operator who steered it. A permission answered by another client immediately shows
that decision and removes the choices.

**Cancel turn** ends the current turn. **Stop agent** preserves the conversation,
backlog, and Worktree. The next message resumes the saved provider session when
supported; there is no separate resume control. **Archive session** closes execution and retains the conversation and working
context. **Restore session** makes it available again without starting a provider
or terminal. Session deletion is not exposed to users. Navigating away, disconnecting, or
closing the window leaves the agent running; quitting the app stops it.

The terminal button in a Session's header opens a resizable bottom panel of
shells in that Session's Worktree. Its open state and height are remembered per
device. Leaving the Session detaches these shells; archiving it stops them and
retains their transcripts. Restarting the daemon retains history
and marks interrupted runs; the next message resumes them.

`useAgentSessionsStore` subscribes to snapshots and replays the committed event
journal in sequence order. Reconnecting checks pending operation IDs instead of
submitting prompts again. Local drafts remain in the running client until their
submission is confirmed. `AgentClient` carries ACP JSON-RPC over the ordered
`deskfleet-acp` DataChannel; preload and main only carry SDP/ICE signaling. See
[Agent Sessions](../../agents/docs/agent-sessions.md) for persistence and concurrency.

## Terminal

`TerminalSurface` wraps xterm.js and its fit addon. It fits the terminal to its
container on resize and disposes of it on unmount. The terminal view remounts it
for each terminal session. The real local machine lists its machine-scoped
sessions in tabs and supports dialing new or existing shells, live input/output, resize,
reattachment, and explicit hangup. Switching tabs, leaving the view or closing
the window leaves shells running. Closing a tab hangs up only its shell and removes
its daemon history. Daemon shutdown terminates processes while preserving their
history; after restart they appear interrupted and read-only. xterm.js uses an injected
stylesheet, which the renderer CSP's `style-src 'unsafe-inline'` permits. It
loads only with the terminal route's chunk.

The data-only connection reuses authenticated SDP/ICE signaling without media
tracks or screen capture. Dial/hangup uses signaling and remains available without
a data peer. Output is acknowledged after xterm consumes it, and reconnecting
replays full persisted history. The visible scrollback is 5,000 lines, without
changing the daemon's retention; it will become a Terminal setting. Tabs show
the connection as an icon and use the title the running program reports. See
[terminal integration](../../agents/docs/terminals.md) for the wire contract and
authorized remote signaling.

## Desktop playback

With the local Agent running, open **Remote desktop** under the real local
machine. Select a display and a codec supported by both the native
encoder and Chromium, then connect. System audio is optional and defaults off.
The video surface hides Chromium's playback controls; the page provides its own
fullscreen action. Disconnect or leave the route to release capture; the daemon
keeps running.

Electron's main process discovers the local daemon through
`~/.deskfleet/daemon.json`. Set `DESKFLEET_DAEMON_DIRECTORY` in both processes to
use an isolated instance. The preload carries signaling and control only;
Chromium's `RTCPeerConnection` and `<video>` handle incoming media. Remote signaling goes through the backend; keyboard/mouse control remains separate work.

See [media integration](../../agents/docs/media.md) for supported capture
platforms, permissions, ownership, and the native pipeline.

## Tray lifecycle

The client stays resident in the system tray: the macOS menu bar, the Windows
notification area, or a Linux StatusNotifier/AppIndicator host. GNOME needs the
AppIndicator extension to show it. Closing the window hides it, as do Cmd+Q, the
Dock menu, and any other ordinary quit request. On macOS the Dock icon is shown
only while the window is.

The process exits only through:

- **Quit deskfleet** in the tray menu;
- OS logout or shutdown (`powerMonitor` `shutdown` on macOS and Linux, window
  `session-end` on Windows);
- SIGINT or SIGTERM.

`src/main/lifecycle.ts` owns this rule. To exit the process, call its `quit()`
rather than `app.quit()`. A second launch shows the existing window instead of
starting another client.

## Launch at startup

**Settings → Preferences → Launch at startup** opens the desktop client when the
user logs in. Packaged macOS and Windows apps use Electron's
`app.getLoginItemSettings()` and `app.setLoginItemSettings()`; the OS owns the
preference, and Settings reads it again after each change. Windows also honors
startup entries disabled in Task Manager. The switch is unavailable on Linux
and in development runs, which use Electron's executable instead of an installed
deskfleet app. macOS login items require a signed and notarized app to work
reliably; see [Electron's login item documentation](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows).

This launches the client with its normal window and respects the separate
**Run local Agent** preference described below.

## Keep Awake

**Settings → Preferences → Keep Awake** prevents automatic system sleep while
the desktop app runs, including while its windows are closed to the tray. It is
disabled by default and applies independently of **Run local Agent**. Displays
can still turn off normally.

The main process saves the preference in `keep-awake.json` under Electron's
`userData` directory and restores it on startup. It owns an Electron
`powerSaveBlocker` with `prevent-app-suspension`, released when the setting is
disabled or the app quits.

## Desktop notifications

**Settings → Notifications** has an overall desktop notification switch and
separate switches for completed tasks and tasks needing a response. All three
default to enabled. Disabling the overall switch preserves the category choices.
These preferences apply to this installation and are saved in `notifications.json`
under Electron's `userData` directory. The Web client does not expose them.

The main process observes synchronized Session snapshots for the signed-in
account's accessible machines, including machines outside the current view.
It shows a native notification when a turn completes successfully or a new
question or permission request awaits a response. Cancelled, interrupted, and
failed turns do not produce completion notifications. Existing history is
baselined at startup and newly discovered machines; subsequent snapshots and
reconnections do not repeat the same notification. Requests already resolved
when synchronization arrives do not notify. When a previously unseen Session
arrives after the initial read, its event timestamps exclude activity predating
monitoring; this assumes the desktop and executing machine clocks agree.

Notifications continue while the window is hidden in the tray. Clicking one
shows the app. Delivery depends on backend synchronization and the operating
system's notification settings. Electron's native notification API requires a
signed macOS application; see the [Electron notification documentation](https://www.electronjs.org/docs/latest/api/notification).

## Local Agent

**Settings → Preferences → Run local Agent** is enabled by default. The main process stores
`localAgentEnabled` in `settings.json` under Electron's `userData` directory.
Enabling it starts the bundled daemon library in the app's main process, or
reuses the authenticated daemon already serving the same discovery directory,
such as a standalone SEA. There is no separate Node.js or daemon installation
to configure, and the app starts no separate daemon process.

On macOS, a newly started Agent immediately requests screen/system-audio recording
access. Settings shows a permission notice while access is pending, denied, or
unavailable; granted access has no notice. The Agent's running status stays
separate. If access was previously denied, enable it in System Settings → Privacy
& Security → Screen & System Audio Recording, then turn the local Agent off and
on. Waiting for consent or denying it leaves terminals and other Agent work
available. Reusing an already running Agent does not repeat the request.

Turning the switch off requests authenticated daemon shutdown, including active
agent and terminal processes, and waits for cleanup. Workspace data, conversation
history, and terminal history remain on disk. Turning it back on reconnects the UI to the new daemon. A failed
start or stop appears in Settings with a retry action. Disabled startup does not
terminate a daemon started separately; Settings reports it as running separately.

Closing the window keeps the app in the tray and the daemon running. Quitting
the app from the tray, ending the OS session, or sending a termination signal
shuts the hosted daemon down and waits for its cleanup before exiting; a reused
standalone daemon is only disconnected. Daemon logs go to the app's output;
discovery, SQLite data, and terminal history retain their usual locations. `DESKFLEET_DAEMON_DIRECTORY` selects an
isolated instance for both the client and its bundled daemon.

## Localization

`packages/components/locales/<locale>.json` holds one catalog per supported locale. Currently these
are `en-US` and `zh-cmn-Hans-CN`. The main process selects the first supported
locale from the OS language preferences and passes it to the preload through
`additionalArguments`. The renderer reads it from `window.deskfleet.locale`.

The main process translates with `t()` from `src/main/i18n.ts`. Components use
`useI18n()` from vue-i18n, not the global `$t`, which Vapor components do not
receive. `@intlify/unplugin-vue-i18n` selects vue-i18n's runtime-only build,
which compiles messages without `eval` under the renderer's CSP. Tests check that
catalogs share keys and parameters and that literal `t("…")` keys exist.

## Styling

Colors are CSS custom properties in `packages/components/src/styles.css`, with light and
dark values. UnoCSS exposes them as `*-ui-<name>` utilities. presetMini has no
preflight and omits some Wind utilities such as `list-none`, so `styles.css` also
holds a small base reset.

UnoCSS uses `presetMini` from `uno.config.ts`. The renderer imports the generated
utilities through `virtual:uno.css`, and production builds emit them as a static
stylesheet.

## Renderer security

The renderer runs with context isolation, the Chromium sandbox, and no Node
integration. The preload exposes `window.deskfleet` (`packages/client/src/desktop-api.ts`)
only to the main renderer document. Keep that interface narrow; agent output and
repository content are untrusted display data.

Bundled builds load from the privileged `deskfleet-app://bundle/` scheme, which
serves only files inside `out/renderer`. Development builds accept only the fixed
loopback Vite URL. Each build injects its Content Security Policy into
`index.html`. Production builds forbid renderer HTTP/WebSocket connections;
WebRTC carries peer media and a narrow preload API carries authorized central signaling. The
media policy permits local streams.
The window denies new windows, navigation, and Chromium permission requests.
Routing uses hash history so every route stays on the single bundled document.

## Vue rendering

Production renderer builds compile every `<script setup>` component in Vapor mode.
`vaporInteropPlugin` lets Vapor components render inside VDOM library components
such as `RouterView`. Vitest compiles the same components to VDOM because Vue
Test Utils requires VDOM instances, so unit tests do not cover Vapor-specific
behavior.

## Packaging

```sh
mise run desktop:package:dir  # unpacked app in release/
mise run desktop:package      # dmg and zip, NSIS, or AppImage for the host platform
```

`electron-builder.yml` configures packaging. Vite bundles every dependency into
`out/`, including the `@deskfleet/daemon` library. The native addon is copied next
to the main bundle and unpacked from ASAR for loading; installer builds use the
release addon. The app has no runtime `node_modules` or external Node dependency.
The app's main process hosts the daemon. The same installed executable runs the
bundled Codex and Claude Code ACP adapters with `--codex-acp` and
`--claude-agent-acp` in Electron's Node mode. The `RunAsNode` fuse stays enabled
for those adapter processes. Packages enable ASAR
integrity validation and disable the `NODE_OPTIONS` and `--inspect` fuses.
electron-builder signs macOS builds when it finds a signing identity; set
`CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned local builds.

`build/icon.png` is the source for the macOS `.icns` and Windows `.ico`. The tray
uses `build/trayTemplate*.png` on macOS and `build/tray*.png` elsewhere. These
images are placeholders that `scripts/generate-icons.ts` draws. Regenerate them
with `mise exec -- pnpm --filter @deskfleet/desktop icons`, or replace them with
real artwork of the same sizes.

## Checks

```sh
mise run check:desktop-types  # vue-tsc over all processes, configs, and scripts
mise run check:desktop        # Vitest: main/shared in Node, renderer in happy-dom
mise run backend:smoke-clients # Web and Electron login, remote RTC, archive, and history (TEST_DATABASE_URL)
mise run desktop:smoke-media  # real Chromium/native H.264 decode; no screen capture
mise run desktop:smoke-terminal  # real PTY I/O, resize, and reattachment over WebRTC
mise run desktop:smoke-catalog  # built renderer CRUD, SQLite persistence, and directory shell cwd
mise run desktop:smoke-agent  # conversation, backlog, steering, permissions, and restart recovery
mise run desktop:smoke-startup  # client, daemon, and bundled adapter entry-point routing
mise run desktop:smoke-local-agent  # Settings toggle, hosted daemon lifetime, and standalone reuse
```

The catalog smoke uses an isolated daemon database and Electron profiles. It
drives the production Vapor Workspace form, folder picker, and preload, changes the default by
reordering paths, opens a real shell in that directory, and reopens the client to
verify the saved catalog before deleting it.

The local Agent smoke uses a temporary profile and daemon directory with the real
built renderer, preload, Settings controller, and hosted daemon. It verifies
default startup, switching off and on, catalog refresh, terminal interruption on
shutdown, notification category choices and master-switch persistence across
restart, the daemon surviving its window but not the app, a fresh daemon on
relaunch, the persisted disabled preference, and reuse of a standalone daemon
that outlives the app.

The Agent Session smoke drives the production renderer through real WebRTC,
SQLite persistence, and managed Git checkouts with a scripted ACP provider. It
checks streaming, shared backlog steering, permission decisions, leaving and
returning to the session, live staged/unstaged/untracked diff previews, and history
recovery after restarting both daemon and client. It edits a file while its diff
is open to verify live updates independent of provider events. The startup smoke
checks entry-point routing and starts the bundled
Codex and Claude Code adapters without paid inference.

vue-tsc uses the TypeScript compiler API, which TypeScript 7 does not provide. The
package therefore installs TypeScript 6 under the `typescript` name. The root
workspace still type-checks the daemon and scripts with TypeScript 7.
