# DeskFleet desktop

The desktop display name is **DeskFleet**, configured in `electron-builder.yml`
and the native window, menu, and About labels. The runtime `productName` in
`package.json` remains `deskfleet`: Electron uses it for the default profile
directory and macOS/Linux secure-storage identity. Keeping that internal name
preserves existing settings, encrypted sign-in tokens, and explicit
`--user-data-dir` overrides. Release artifact filenames retain the `deskfleet-`
prefix.

`@deskfleet/desktop` is the Electron client for the machine daemon, which it hosts
in its main process. Closing the window leaves the app in the tray with the daemon
and its agent sessions running; quitting the app stops them. The renderer uses Vue
with vue-router, Pinia, VueUse, vue-i18n, UnoCSS, Lucide icons, and xterm.js.

## Development

Start `mise -E development run dev` from the repository root to run the API and
Web login pages. Keep that terminal running, then use another terminal:

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

Set `VITE_DESKFLEET_SERVER_URL` before starting development or building the app
to choose the backend; it defaults to `http://localhost:8080`. For example, in
PowerShell:

```powershell
$env:VITE_DESKFLEET_SERVER_URL = "https://api.example.com"
mise run desktop:build
```

Vite embeds the address in the main-process bundle. Changing the backend requires
rebuilding the app; environment variables set only when launching a built app
do not override it. The UI has no backend-address setting. The server address
stored with an account only scopes its saved credentials to the compiled backend.

Statsig behavioral events and UI experiments run in the renderer when
`VITE_STATSIG_CLIENT_KEY` is set before development or building. Use a Statsig
**client-public** SDK key, never a server secret: this value is embedded in the
renderer bundle. An unset or blank key disables Statsig.
`VITE_STATSIG_ENVIRONMENT` optionally selects the Statsig environment and defaults
to Vite's mode (`development` or `production`). The renderer reads `.env` files
from `apps/desktop/src/renderer/`, including mode-specific files; process
environment values take precedence. Rebuild the app after changing either value.

The renderer's Content Security Policy adds only the three configured Statsig
origins (`https://featureassets.org`, `https://prodregistryv2.org`, and
`https://statsigapi.net`) when a client key is present. Without Statsig or Sentry,
production retains `connect-src 'none'`. Account and machine API traffic remains
in the main process. Statsig gates and experiments control frontend experience only;
the server and daemon continue to enforce authorization, entitlements, and quotas.
See the [analytics guide](../../agents/docs/analytics.md) for identity, events,
and the shared API.

Sentry error reporting is independently optional in the renderer. Set
`VITE_SENTRY_DSN` to a public Sentry DSN before development or building;
missing, blank, or invalid values disable reporting. `VITE_SENTRY_ENVIRONMENT`
defaults to Vite's mode. These values use the same environment-file location and
rebuild rules as Statsig. Tagged builds automatically use the same Sentry release
as Web, such as `deskfleet@v0.2.1`. The renderer CSP adds only the configured DSN's
origin. See the [error-reporting guide](../../agents/docs/error-reporting.md) for scope and data
collection.

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

The production client signs in to a configured backend through its owned account system and selects
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
to it. Team creation/joining and Add machine open focused dialogs. The Team menu
opens a separate Team settings area for the name, members and roles, machines,
and Plans & Usages. The footer Settings button opens application preferences,
appearance, notifications, and machine configuration. Both settings areas remain
available while a Team has no machines. The account menu and sign-out action
live in the sidebar footer.
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

On this client's local machine, a Workspace's **Open with** menu opens its default
directory in VS Code, Cursor, VSCodium, Zed, an external Terminal, or the system
file manager. Additional directories have their own menu. Only installed
applications appear; opening the menu or choosing **Rescan** scans
again. The existing terminal actions continue to open DeskFleet's integrated
terminal. Remote machines and Web clients do not expose these local launchers.

The maintained discovery list lives in
[`crates/native/src/local_applications/registry.rs`](../../crates/native/src/local_applications/registry.rs).
It checks platform installation locations and executable search paths without
running applications during discovery. Launches resolve the selected application
again and pass the directory as an argument or working directory, without shell
interpolation. The preload bridge accepts application and resource IDs; the main
process verifies local enrollment and resolves paths from the daemon's live catalog
through the authenticated `catalogList` management RPC. Newly created or edited
Workspace directories are available without waiting for central catalog sync.

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
that takes over the toolbar while the sidebar is hidden. The Changes panel on the
right shows Git changes for the current Session; its visibility persists per
device. The macOS traffic lights sit in the sidebar's toolbar row.
The Windows and Linux controls overlay the window's top-right corner, which the
rightmost header reserves with `.titlebar-overlay-inset`
(`src/main/window-chrome.ts`).

The tree follows the resource model: machines contain workspaces, and workspaces
list their Sessions. Each Session exposes its associated Worktree. Each machine has
one **Remote control** entry with Terminal, Desktop, File transfer, and System
status tabs. This client's own daemon is marked **This machine** and uses a
**Local control** entry with Terminal, File transfer, and System status; it does
not expose its own Desktop tab.
Machine terminals live there; a Session's terminals stay in its bottom panel.
The local machine and headless remote machines default to Terminal; graphical
remote machines default to Desktop. Desktop links targeting the local machine
also open Terminal. Other clients can still access this machine's desktop.
Switching tabs preserves mounted tools and their connections. Offline
machines start collapsed and report when they were last seen.

| Route | View |
| --- | --- |
| `/` | New session: a composer targeting a machine, workspace, and provider |
| `/workspaces/:workspaceId` | Workspace name, ordered directories, Sessions, default-directory terminal, and deletion |
| `/worktrees/:worktreeId` | Directory bindings and the owning Session of a session Worktree |
| `/sessions/:sessionId` | Conversation, tools, permissions, candidate backlog, composer, and agent lifecycle |
| `/terminals/:terminalId` | Redirects machine terminals to Remote control and Session terminals to their Session's panel |
| `/machines/:machineId/control` | Machine tools selected by `tab=terminal`, `tab=desktop`, `tab=files`, or `tab=system`; local machines omit Desktop; `terminal` selects a shell |
| `/machines/:machineId/terminals` | Redirects to the Terminal tab in Remote control |
| `/machines/:machineId/desktop` | Redirects to Desktop for remote machines or Terminal for this client's local machine |
| `/settings/preferences` | Preferences, including launch at startup and the local Agent under This computer |
| `/team/settings` | Team name, members and roles, and machines |
| `/team/settings/plans` | The selected Team's plan, usage, and subscription management |

A Workspace page's New session action makes that Workspace the composer's target.
Worktree links and lookups only resolve Session-owned contexts.

Settings routes (`meta.fullWindow`) replace the sidebar and Changes panel with
two panels: the sections on the left and the selected section on the right.
Section links replace their history entry, so **Back to app** or Escape returns
to the page Settings opened from. **Preferences → This computer** contains
**Launch at startup**, **Keep Awake**, and **Worktree root directory** alongside
the local Agent startup preference, run state, and retry.

The **Changes** panel inspects the Session's actual directories on the local
daemon, grouping files by checkout and staged, unstaged, or untracked state,
with status letters and line counts. Select a file to open a diff preview. Both
the list and the open diff refresh automatically every 1.5 seconds after the
previous read, including changes made outside the agent. Closing the panel or
hiding the window pauses refreshes. Non-Git directories, binary files, large
truncated diffs, and read errors have explicit states. It is empty for
machine and workspace terminals and for desktops, which belong to no worktree.
Workspace and Worktree pages retain their directory information.

## Agent sessions

Settings → Agents manages the machine's configured providers, including their
names, icons, executable paths, and environment overrides. The Codex, Claude
Code, and Pi Coding Agent templates use their installed and authenticated CLIs
through bundled ACP adapters. Pi setup opens its terminal interface: enter
`/login`, complete authentication, then `/quit`. Pi supports model and reasoning
selection and resuming saved sessions.
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
model and effort choices come from that provider's ACP configuration options, including reasoning levels the selected model advertises.
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

`TerminalSurface` wraps xterm.js with its fit, ligatures, and WebGL addons. It
attaches `@xterm/addon-webgl` after open when WebGL2 is available, and falls back
to the default canvas renderer when WebGL is missing, fails to initialize, or
loses its context. Unmount force-releases the WebGL2 context so tab remounts do
not accumulate GPU contexts past Chromium's limit. It fits the terminal to its
container on resize and disposes of it on unmount. The terminal view remounts it for each terminal session. The
real local machine lists its machine-scoped sessions in tabs and supports dialing
new or existing shells, live input/output, resize, reattachment, and explicit
hangup. Switching tabs, leaving the view or closing the window leaves shells
running. Closing a tab hangs up only its shell and removes its daemon history.
Daemon shutdown terminates processes while preserving their history; after restart
they appear interrupted and read-only. xterm.js uses an injected stylesheet, which
the renderer CSP's `style-src 'unsafe-inline'` permits. It loads only with the
terminal route's chunk.

The data-only connection reuses authenticated SDP/ICE signaling without media
tracks or screen capture. Dial/hangup uses signaling and remains available without
a data peer. Output is acknowledged after xterm consumes it, and reconnecting
replays full persisted history. The visible scrollback is 5,000 lines, without
changing the daemon's retention; it will become a Terminal setting. Tabs show
the connection as an icon and use the title the running program reports. See
[terminal integration](../../agents/docs/terminals.md) for the wire contract and
authorized remote signaling.

## Desktop playback

With the local Agent running, open **Remote control → Desktop** under the real
local machine. Select a display, then connect. The viewer uses the first of AV1,
HEVC, and H.264 that both the display's encoder and Chromium support, shows that
codec as status text, and opens a new peer for the next codec only when the
encoder fails. System audio is optional and defaults off.
The video surface hides Chromium's playback controls; the page provides its own
fullscreen toggle, keeping the floating toolbar available in fullscreen.
Switching away from the Desktop tab disconnects capture while preserving its
display and stream settings. Returning to Desktop requires reconnecting manually.
Leaving the Remote control page also releases capture. The daemon keeps running.

Electron's main process discovers the local daemon through
`<userData>/daemon/daemon.json`, using the app's existing Electron profile.
The preload carries signaling and control only;
Chromium's `RTCPeerConnection` and `<video>` handle incoming media. Remote signaling goes through the backend; keyboard/mouse control remains separate work.

See [media integration](../../agents/docs/media.md) for supported capture
platforms, permissions, ownership, and the native pipeline.

The Remote control page's File transfer tab contains the two-pane file browser.
The local pane opens the user's home directory with the app's existing OS file
access. **Choose folder** changes the location without an additional authorization
step; browsing and transfers remain subject to OS permissions.
Its queue belongs to Electron main and continues through navigation and tray
operation, independently of desktop playback. Agent file/image references use
the same file service. See [files and transfers](../../agents/docs/files.md).

## Tray lifecycle

The client stays resident in the system tray: the macOS menu bar, the Windows
notification area, or a Linux StatusNotifier/AppIndicator host. GNOME needs the
AppIndicator extension to show it. Closing the window hides it, as do Cmd+Q, the
Dock menu, and any other ordinary quit request. On macOS the Dock icon is shown
only while the window is.

The process exits only through:

- **Quit DeskFleet** in the tray menu;
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
DeskFleet app. macOS login items require a signed and notarized app to work
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

## Worktree root directory

**Settings → Preferences → Worktree root directory** chooses where this computer
stores worktrees for new Sessions. **Choose folder** opens the native folder
picker and saves the selected directory. **Use default** restores the default
directory displayed by Settings. Choose a location on another disk when the
default disk has limited free space.

Changes apply to newly created Session worktrees immediately, without restarting
the app. Existing worktrees stay at their recorded paths. Sessions using
**Working directory** continue to use their Workspace's directories.

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

## Welcome and initial setup

The welcome page guides macOS Local Network access, Full Disk Access,
screen/system-audio recording, and Accessibility in that order, then signs in
to the compiled backend. Local Network access supports direct connections to
other machines and is offered even when the local Agent is disabled.
The desktop host saves the current step in `onboarding.json` under `userData`;
closing the window or restarting the app resumes the unfinished step. Startup
starts or reuses the local Agent when its saved preference is enabled. macOS
startup checks permissions silently; Wayland requests its combined desktop
authorization during startup. Clients with local Agent startup disabled and no
running daemon skip the Agent's permissions. Other platforms without permission
steps proceed directly to sign-in.

Each permission page explains the capability and provides an explicit request,
a way to continue without it, and a status refresh where the OS supports checking.
Local Network has explicit **Request access** and **Open System Settings** actions;
macOS does not expose a general permission-status API, so the page does not claim
that requesting access granted it. If no prompt appears, review DeskFleet under
**System Settings → Privacy & Security → Local Network**. Returning from System
Settings refreshes the other permission states silently. Full Disk Access must be enabled
for the app or executable hosting the Agent; restart that host if macOS requires
it. Permission denial does not prevent sign-in or unrelated Agent operations.
Completed setup is not repeated at each launch. Signed-out users and Web clients
use the same welcome design for account sign-in.

## Local Agent

**Settings → Preferences → Run local Agent** is enabled by default. The main process stores
`localAgentEnabled` in `settings.json` under Electron's `userData` directory.
Enabling it starts the bundled daemon library in the app's main process, or
reuses an authenticated standalone daemon explicitly configured to serve the
same `<userData>/daemon` directory. There is no separate Node.js or daemon
installation to configure, and the app starts no separate daemon process.

Creating the local Agent checks OS access without opening permission dialogs;
the welcome flow guides explicit requests one at a time. Local Session file
previews load automatically, without a separate permission button or confirmation
dialog. Settings shows a notice while OS access is pending, denied, or unavailable;
granted access has no notice. The Agent's running status stays separate. Waiting
for consent or denying it leaves other Agent work available, subject to OS file
permissions. Reusing an already running Agent does not repeat its startup requests.

Turning the switch off requests authenticated daemon shutdown, including active
agent and terminal processes, and waits for cleanup. Workspace data, conversation
history, and terminal history remain on disk. Turning it back on reconnects the UI to the new daemon. A failed
start or stop appears in Settings with a retry action. Disabled startup does not
terminate a daemon started separately; Settings reports it as running separately.

Closing the window keeps the app in the tray and the daemon running. Quitting
the app from the tray, ending the OS session, or sending a termination signal
shuts the hosted daemon down and waits for its cleanup before exiting; a reused
standalone daemon is only disconnected. Daemon logs go to the app's output;
discovery, SQLite data, provider settings, and terminal history live under
`<userData>/daemon`. The app uses its existing Electron `userData` directory,
including a `--user-data-dir` override, and ignores `DESKFLEET_DAEMON_DIRECTORY`.
Headless daemons still default to `~/.deskfleet` and support that environment
override. The desktop app does not import data from the headless directory.

## Localization

`packages/components/locales/<locale>.json` holds one catalog per supported locale. Currently these
are `en-US`, `zh-cmn-Hans-CN`, and `ja-JP`. The main process selects the first supported
locale from the OS language preferences and passes it to the preload through
`additionalArguments`. The renderer reads it from `window.deskfleet.locale`.
The Web client uses the same catalogs and resolves browser language preferences.
Settings → Appearance → Language can override the system language with a saved
selection; Japanese is listed as **日本語**.

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
`index.html`. Production builds forbid renderer HTTP/WebSocket connections except
for the three fixed Statsig origins when analytics is configured and the Sentry
DSN origin when error reporting is configured. WebRTC carries peer media and a
narrow preload API carries authorized central signaling. The
media policy permits local streams.
The window denies renderer navigation and new Electron windows. Explicit HTTP(S)
links requesting a new window open in the system browser; other schemes remain
blocked. Chromium permissions allow only
clipboard writes and fullscreen from the main renderer document; clipboard reads
and all other permission requests remain denied.
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
bundled Codex, Claude Code, and Pi ACP adapters with `--codex-acp`,
`--claude-agent-acp`, and `--pi-acp` in Electron's Node mode. The `RunAsNode` fuse stays enabled
for those adapter processes. Packages enable ASAR
integrity validation and disable the `NODE_OPTIONS` and `--inspect` fuses.
electron-builder signs macOS builds when it finds a signing identity; set
`CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned local builds.

Tagged releases use `electron-builder.release.yml` on macOS. This overlay
requires Developer ID signing and Apple notarization; missing credentials or
failed notarization fail the release build. It keeps the base installer targets
and fuses, with the final Developer ID signature applied after the fuse changes.
The app and helpers receive the V8 JIT entitlement. The bundled native addon is
signed with the app; loading it does not require disabling library validation.

Before pushing a release tag, create the GitHub `production` environment with
deployment access restricted to tags matching `v*` and no branches. Set its
`VITE_DESKFLEET_SERVER_URL` variable to the official API origin; a missing or
empty value fails the release build. Optional `VITE_STATSIG_CLIENT_KEY` and
`VITE_STATSIG_ENVIRONMENT` variables configure analytics. Optional
`VITE_SENTRY_DSN` and `VITE_SENTRY_ENVIRONMENT` variables configure renderer error
reporting; the workflow derives the Sentry release from the Git tag. The workflow
supplies the API origin only to Electron; the Web artifact stays same-origin.

PR, main, and manual Build runs do not bind this environment: their installers
use the localhost backend, leave Statsig and Sentry disabled, and skip release
signing.
Keep production values out of repository and organization variables and secrets.
See [release configuration](../../agents/docs/ci.md#tagged-releases) for the
environment settings.

Configure these secrets in the same environment:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application certificate and private key exported as a `.p12` file. |
| `MAC_CSC_KEY_PASSWORD` | Password for that `.p12` file. |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect API `.p8` private key. |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID. |

The release workflow decodes the API key into a temporary runner file and passes
it as `APPLE_API_KEY`, alongside `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
electron-builder imports the certificate from `CSC_LINK` with
`CSC_KEY_PASSWORD`. For local signed packaging with those environment variables
configured:

```sh
mise run desktop:release-build
mise exec -- pnpm --filter @deskfleet/desktop exec electron-builder --config electron-builder.release.yml --publish never
```

The tagged build stages macOS arm64 DMG/ZIP, Windows x64 NSIS, and Linux x64/arm64
AppImage installers in a draft GitHub Release. After that release is published,
the website resolves the latest stable installers through GitHub's releases API.
See [release workflow](../../agents/docs/ci.md) for tag validation and publishing.

The original brand artwork lives in
`packages/components/src/assets/deskfleet.png`. Run
`mise exec -- pnpm --filter @deskfleet/desktop icons` to regenerate the app, tray,
Web, and website icons from it. `build/icon.png` is the source for the macOS
`.icns` and Windows `.ico`. The tray uses `build/trayTemplate*.png` on macOS,
with the artwork's luminance adapted to an alpha mask for system tinting, and
full-color `build/tray*.png` elsewhere. Commit generated assets with the source.

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

The local Agent smoke uses a temporary profile and its daemon directory with the
real built renderer, preload, Settings controller, and hosted daemon. It verifies
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
Codex, Claude Code, and Pi adapters without paid inference.

vue-tsc uses the TypeScript compiler API, which TypeScript 7 does not provide. The
package therefore installs TypeScript 6 under the `typescript` name. The root
workspace still type-checks the daemon and scripts with TypeScript 7.
