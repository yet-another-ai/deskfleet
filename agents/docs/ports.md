# TCP port forwarding

Clients can forward a local loopback TCP listener to a loopback TCP port on an
enrolled Machine over WebRTC. Remote control's **Port forwarding** tab manages
manual listeners for the selected Team and Machine in the Desktop app. Pure Web
browsers expose neither this tab nor a local forwarding API; Capacitor iOS and
Android clients expose only the programmatic `ports` bridge (through
`crates/desktop-viewer` JNI/C-FFI and `@deskfleet/capacitor-bridge`) to power
Session Web Preview.

```text
Local browser / WebView / debugger / other TCP client
  -> 127.0.0.1:<local port>
  -> Local WebRTC peer (Desktop main or Capacitor native bridge)
  -> WebRTC DataChannel -> target daemon
  -> 127.0.0.1:<target port> or [::1]:<target port>
```

The central backend authorizes and signals the connection. ICE uses the
configured STUN/TURN servers; TURN relays encrypted peer traffic when needed.
No TCP payload passes through the backend API or conversation history.

## Ownership and lifetime

`PortForwards` in Desktop main owns each listener and its independently authorized
peer. Navigation, switching Machines, closing a window, and disabling the local
Agent do not own these resources. Stopping a forward, quitting Desktop, changing
accounts, losing the peer, or reaching authorization expiry closes the listener
and all its TCP connections. Signaling loss alone preserves a working peer
within its grant. Failed forwards are removed from `list()`; reconnecting requires
a new `start()` and new TCP connections.

The target daemon owns the remote sockets. Closing those sockets does not stop
the target service. Forwards are ephemeral and are not catalog resources. They
target a Machine's network environment, without a Workspace or Session ownership
association. A Worktree does not provide a separate network namespace.

## Remote control UI

The tab is available on remote Machines and can be opened directly with
`?tab=ports`. Add forwarding chooses an IPv4 or IPv6 loopback destination, a
remote TCP port, and an optional local port. Leaving the local port blank asks
the OS to select an available port. The active list shows the actual local
address, supports copying it, and stops individual forwards.

The renderer filters the host-wide list by both Team and Machine. It refreshes
while the tab is active and when returning to it; navigating away does not stop
listeners. Offline Machines cannot start new forwards, but existing listeners
can still be stopped. Configuration is not saved or automatically reconnected.

## Programmatic Desktop API

The trusted main renderer's existing preload bridge exposes `window.deskfleet.ports`:

```ts
const forward = await window.deskfleet.ports.start({
  target: { teamId, machineId },
  targetHost: "127.0.0.1",
  targetPort: 3000,
  localPort: 0,
})
// Connect to 127.0.0.1:<forward.localPort> using an ordinary TCP client.
const active = await window.deskfleet.ports.list()
await window.deskfleet.ports.stop(forward.id)
```

`targetHost` defaults to `127.0.0.1`; only the exact literals `localhost`,
`127.0.0.1`, and `::1` are accepted (`localhost` instructs `deskfleet-ports`
to try `[::1]` and then `127.0.0.1` without DNS resolution). `targetPort` is
1–65535. `localPort` defaults to zero, asking the OS
to choose an available port; an explicit port must be available. Local listeners
always bind `127.0.0.1`. Both Electron preload (`window.deskfleet.ports` from
the trusted main renderer) and the Capacitor bridge expose this API. There is no
automatic discovery, persistent daemon-side forwarding, UDP, reverse forwarding,
or remote LAN destination support.

## Authorization and native transport

The server issues a `ports` peer with the `ports:forward` action after checking
the authenticated user, Team, and target Machine. The daemon validates that
purpose and action before enabling the native responder, then applies the SDP.
Other peer purposes never enable the responder, regardless of channel labels.
The grant authorizes loopback TCP destinations on that Machine; it is not a
filesystem restriction or a grant to a particular Workspace.

The daemon passes the immutable grant's absolute expiry to Rust. Native socket
and channel work checks wall-clock expiry, including after resume from suspend,
and idle expiry also stops the bridge. Explicit revocation closes the owning
peer through `AuthorizedPeers`. The general identity and signaling rules remain
in [WebRTC security](webrtc-security.md).

The native `deskfleet-ports` reliable, ordered DataChannel carries binary frames
for connection opening, opening acknowledgment, data, credit, half-close, and
reset. One peer serves one local listener and up to 32 simultaneous TCP
connections. Each connection has a bounded credit window of eight 16 KiB chunks
per direction. Credits return as the receiving socket consumes data, allowing a
slow receiver to stop upstream reads. Connection errors reset only that TCP
connection; closing the DataChannel closes the whole forward.

Port payloads stay in Rust and bypass the general peer-event broadcast queue.
The napi binding exposes only configuration and the chosen local port, while
ordinary peer events carry signaling and lifecycle changes to TypeScript.
Both TCP directions close independently so a service can respond after its
client sends FIN. Connections share an ordered channel and can therefore share
transport head-of-line delays.

## Validation

Native tests exercise real WebRTC peers and loopback sockets (including
`localhost` auto-family probing and the mobile JSON command registry). Desktop
tests cover parameter validation, trusted-renderer access, native adaptation,
`WebPreviewController` `<webview>` lockdown, and cleanup of active and pending
forwards. Electron smoke verification (`desktop:smoke-web-preview`) exercises a
real `<webview>` guest under production CSP, including loading `X-Frame-Options: DENY`
content, preload stripping, and main-frame origin containment. Signaling tests
cover early ICE, revocation, expiry, account changes, setup cancellation, and
signaling outages.

The existing backend smoke workflow also exercises port forwarding through the
real owned-account/PostgreSQL backend and daemon, with concurrent binary streams, a
response after TCP half-close, explicit stop, and server revocation. Run it
directly and with a configured TURN service:

```sh
mise -E development run backend:smoke
DESKFLEET_SMOKE_RELAY_ONLY=1 mise -E development run backend:smoke
```

## Session Web Preview

Sessions allow opening multiple interactive Web Preview windows from the Dockview
`+` menu or the compact/mobile overview on Desktop and Capacitor mobile clients.
Pure Web browsers omit Web Preview creation and discard restored Web Preview
entries because browsers cannot bind or tunnel loopback ports safely.

Preview inputs accept loopback port shorthands (`5173`, `:5173/docs`) or HTTP
loopback URLs (`localhost`, `127.0.0.1`, `[::1]`) and reject credentials or
non-`http:` schemes. The toolbar always shows the logical loopback URL while the
underlying transport connects directly on local Desktop machines or opens an
ephemeral `ports.start()` forward (`127.0.0.1:<localPort>`) on remote machines
and Capacitor mobile clients.

- **Desktop (Electron)** renders pages inside an isolated `<webview>` in the
  ephemeral `temp:deskfleet-web-preview` partition. `WebPreviewController` in
  main authorizes loopback origins per `BrowserWindow`, enforces
  `will-attach-webview` and guest `will-navigate` / `will-redirect` containment,
  strips preloads, enables sandbox/context isolation with `nodeIntegration` off,
  denies guest `window.open` and permission prompts, and exposes a Desktop-only
  detached DevTools toggle.
- **Mobile (Capacitor iOS & Android)** binds local forwards through
  `crates/desktop-viewer` JNI / C-FFI (`mobile_ports`), renders in an
  `<iframe>` under loopback-only HTTP cleartext configuration (`NSAllowsLocalNetworking`
  on iOS, loopback `network_security_config.xml` and compatibility mixed-content
  mode on Android), omits DevTools, and allows external browser handoff.

Open targets persist per Session (`deskfleet.window-layout-v4:<sessionId>` and
`deskfleet.mobile-web-previews:<sessionId>`). Restored background tabs and mobile
overview cards remain disconnected until first activated, and keep their live
preview alive once opened until the user changes target port/host or closes the
tab.

## Relation to external editors

[Issue #74](https://github.com/yet-another-ai/deskfleet/issues/74) requests opening
a Workspace or Session in an external editor. TCP forwarding supplies a
transport that a later editor adapter can use to reach an existing remote SSH
service. It does not implement an SSH server, SSH credentials, editor launching,
or selection of Workspace/Session directories. Local editor launching can be
implemented independently. This capability supports that issue without closing it.
