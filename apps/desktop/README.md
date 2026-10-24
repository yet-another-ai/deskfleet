# deskfleet desktop

`@deskfleet/desktop` is the Electron client for the machine daemon. Quitting the
client leaves the daemon and its agent sessions running. The renderer uses Vue
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

`mise run desktop:build` writes the production bundles to `out/`. Run them with
`mise exec -- pnpm --filter @deskfleet/desktop exec electron .`. Electron
downloads its platform binary the first time it is resolved.

## Layout

| Path | Process | Bundle |
| --- | --- | --- |
| `src/main` | Electron main process | `out/main/index.js` (ESM) |
| `src/preload` | Sandboxed preload | `out/preload/index.cjs` (CommonJS) |
| `src/renderer` | Vue renderer | `out/renderer` |
| `src/shared` | Code imported by more than one process | Inlined into each bundle |
| `src/locales` | Message catalogs for the main process and renderer | Inlined into each bundle |
| `build` | Packaging input and runtime window and tray images | Selected files in `app.asar` |

Each process has its own Vite configuration (`vite.main.config.ts`,
`vite.preload.config.ts`, and `vite.renderer.config.ts`).

## Interface layout

`useFleetStore` loads the local daemon's persistent catalog through authenticated
IPC. The desktop starts its bundled local Agent by default; use **Add workspace**
beside the local machine. Supply its name and at least one absolute directory path.
Directories have no names; the first is the default. Move paths up or down to
change their order and default. Creating a Workspace creates its main Worktree
automatically. Edit the Workspace to change its name and directories. Worktrees
are read-only execution contexts: the main one uses actual configured directories,
and Session-owned ones are created and removed by Session lifecycle operations.
Deleting a Workspace removes its catalog records, leaving source directories
untouched; active Sessions prevent deletion. The UI refreshes on catalog changes,
window focus, and the explicit refresh action; failures retain the displayed
catalog and show an error.

The footer identifies this as local mode, without account or organization
membership. Database Machine IDs remain distinct from the `local-daemon`
connection target. The desktop route supports live WebRTC playback; **New
terminal** opens a native PTY, and **Open terminal here** on a worktree directory
starts one at that path. Those terminals retain machine scope. The application
does not display sample machines as live resources.

Accounts, organization switching, remote machine registration, target
and provider pickers, Send, Git inspection, file diffs, and session transcripts
remain unimplemented.
Placeholder controls are labelled, `aria-disabled`, and do nothing. They use
`IconButton`'s `placeholder` state or the `common.placeholderControl` title.

The window is frameless and has three columns. The sidebar holds the window
toolbar (sidebar toggle, back, forward), the New session action, the resource
tree, and a local-mode footer. The main pane shows the routed view under a header row
that takes over the toolbar while the sidebar is hidden. The details panel on the
right describes the current route's resource; its header toggle and its tab
persist per device. The macOS traffic lights sit in the sidebar's toolbar row.
The Windows and Linux controls overlay the window's top-right corner, which the
rightmost header reserves with `.titlebar-overlay-inset`
(`src/main/window-chrome.ts`).

The tree follows the resource model: machines contain workspaces, workspaces
contain worktrees, and each worktree lists its agent sessions. Terminal sessions
appear under whichever machine, workspace, or worktree owns them. Machines with a
graphical session list Remote desktop first; headless machines omit it. Offline
machines start collapsed and report when they were last seen.

| Route | View |
| --- | --- |
| `/` | New session: a composer targeting a machine, workspace, worktree, and provider |
| `/workspaces/:workspaceId` | Workspace name, ordered directories, default-directory terminal, and deletion |
| `/worktrees/:worktreeId` | Directory bindings, agent sessions, and terminals of one worktree |
| `/sessions/:sessionId` | A session's title, location, and composer |
| `/terminals/:terminalId` | A terminal session's owner, cwd, and terminal surface |
| `/machines/:machineId/terminals` | Terminal tabs and the empty terminal workspace |
| `/machines/:machineId/desktop` | A machine's remote desktop surface, or why it is unavailable |
| `/settings/preferences` | Preferences, including the local Agent under This computer |

A worktree page's New session action makes that worktree the new session's
target.

Settings routes (`meta.fullWindow`) replace the sidebar and details panel with
two panels: the sections on the left and the selected section on the right.
Section links replace their history entry, so **Back to app** or Escape returns
to the page Settings opened from. **Preferences → This computer** holds the
local Agent startup preference, run state, and retry.

The details panel has two tabs:

- **Details** lists the resource's owner and properties: a session's provider, a
  terminal's scope and cwd, or a machine's display. Resources in a worktree also
  list its directory bindings with each checkout's branch and HEAD.
- **Changes** lists the worktree's uncommitted Git changes, grouped by checkout,
  with status letters as in `git status --short` and line counts. It is empty for
  machine and workspace terminals and for desktops, which belong to no worktree.

`useRouteResource` resolves the route to that resource. The new session page
describes its target worktree.

## Terminal

`TerminalSurface` wraps xterm.js and its fit addon. It fits the terminal to its
container on resize and disposes of it on unmount. The terminal view remounts it
for each terminal session. The real local machine lists daemon-owned sessions in
tabs and supports dialing new or existing shells, live input/output, resize,
reattachment, and explicit hangup. Switching tabs, leaving the view or quitting
Electron leaves shells running. Closing a tab hangs up only its shell and removes
its daemon history. Daemon shutdown terminates processes while preserving their
history; after restart they appear interrupted and read-only. xterm.js uses an injected
stylesheet, which the renderer CSP's `style-src 'unsafe-inline'` permits. It
loads only with the terminal route's chunk.

The data-only connection reuses authenticated SDP/ICE signaling without media
tracks or screen capture. Dial/hangup uses signaling and remains available without
a data peer. Output is acknowledged after xterm consumes it, and reconnecting
replays full persisted history. The visible scrollback starts at 5,000 lines;
**Load more history** increases it without changing the daemon's retention. See
[terminal integration](../../agents/docs/terminals.md) for the wire contract and
the remaining cross-machine signaling work.

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
Chromium's `RTCPeerConnection` and `<video>` handle incoming media. Central server signaling and
keyboard/mouse control are not connected yet.

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

## Local Agent

**Settings → Preferences → Run local Agent** is enabled by default. The main process stores
`localAgentEnabled` in `settings.json` under Electron's `userData` directory.
Enabling it starts the bundled daemon library in a detached Electron background
process, or reuses the authenticated daemon already serving the same discovery
directory. There is no separate Node.js or daemon installation to configure.
The background process has no window, tray icon, or client single-instance lock.
Its Chromium data is separate from the client's profile.

Turning the switch off requests authenticated daemon shutdown, including active
terminal processes, and waits for cleanup. Workspace data and terminal history
remain on disk. Turning it back on reconnects the UI to the new daemon. A failed
start or stop appears in Settings with a retry action. Disabled startup does not
terminate a daemon started separately; Settings reports it as running separately.

Closing or quitting the client only disconnects its IPC connection. The daemon
keeps running, including across development client reloads. After changing daemon
code during development, toggle the local Agent off and on to load the new bundle.
Logs go to `<daemon directory>/daemon.log`; discovery, SQLite data, and terminal
history retain their usual locations. `DESKFLEET_DAEMON_DIRECTORY` selects an
isolated instance for both the client and its bundled daemon.

## Localization

`src/locales/<locale>.json` holds one catalog per supported locale. Currently these
are `en-US` and `zh-cmn-Hans-CN`. The main process selects the first supported
locale from the OS language preferences and passes it to the preload through
`additionalArguments`. The renderer reads it from `window.deskfleet.locale`.

The main process translates with `t()` from `src/main/i18n.ts`. Components use
`useI18n()` from vue-i18n, not the global `$t`, which Vapor components do not
receive. `@intlify/unplugin-vue-i18n` selects vue-i18n's runtime-only build,
which compiles messages without `eval` under the renderer's CSP. Tests check that
catalogs share keys and parameters and that literal `t("…")` keys exist.

## Styling

Colors are CSS custom properties in `src/renderer/src/styles.css`, with light and
dark values. UnoCSS exposes them as `*-ui-<name>` utilities. presetMini has no
preflight and omits some Wind utilities such as `list-none`, so `styles.css` also
holds a small base reset.

UnoCSS uses `presetMini` from `uno.config.ts`. The renderer imports the generated
utilities through `virtual:uno.css`, and production builds emit them as a static
stylesheet.

## Renderer security

The renderer runs with context isolation, the Chromium sandbox, and no Node
integration. The preload exposes `window.deskfleet` (`src/shared/desktop-api.ts`)
only to the main renderer document. Keep that interface narrow; agent output and
repository content are untrusted display data.

Bundled builds load from the privileged `deskfleet-app://bundle/` scheme, which
serves only files inside `out/renderer`. Development builds accept only the fixed
loopback Vite URL. Each build injects its Content Security Policy into
`index.html`. Production builds forbid renderer HTTP/WebSocket connections;
WebRTC carries peer media and a narrow preload API carries local signaling. The
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
The same installed executable hosts the daemon with `--deskfleet-daemon` and
the bundled Codex ACP adapter with `--deskfleet-codex-acp`, without using
Electron's `RunAsNode` mode. The ACP host runs the adapter in a Node worker and
exits after its Codex subprocess and streams have finished closing. Packages enable ASAR integrity
validation and disable the `RunAsNode`, `NODE_OPTIONS`, and `--inspect` fuses.
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
mise run desktop:smoke-media  # real Chromium/native H.264 decode; no screen capture
mise run desktop:smoke-terminal  # real PTY I/O, resize, and reattachment over WebRTC
mise run desktop:smoke-catalog  # built renderer CRUD, SQLite persistence, and directory shell cwd
mise run desktop:smoke-local-agent  # Settings toggle, daemon reuse, and independent process lifetime
```

The catalog smoke uses an isolated daemon database and Electron profiles. It
drives the production Vapor Workspace form and preload, changes the default by
reordering paths, opens a real shell in that directory, and reopens the client to
verify the saved catalog before deleting it.

The local Agent smoke uses a temporary profile and daemon directory with the real
built renderer, preload, Settings controller, and bundled daemon host. It verifies
default startup, switching off and on, catalog refresh, terminal interruption on
shutdown, terminal survival after client exit, reuse by another client, and the
persisted disabled preference on a third launch.

With an installed, authenticated Codex CLI, run
`mise exec -- node apps/desktop/scripts/smoke-agent-configuration.ts` after building
the desktop app. This starts the production Electron daemon in an isolated
directory and checks dynamic model discovery, model switching, and reasoning
effort changes through its bundled ACP subprocess without sending a prompt.

vue-tsc uses the TypeScript compiler API, which TypeScript 7 does not provide. The
package therefore installs TypeScript 6 under the `typescript` name. The root
workspace still type-checks the daemon and scripts with TypeScript 7.
