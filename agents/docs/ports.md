# TCP port forwarding

Desktop can forward a local loopback TCP listener to a loopback TCP port on an
enrolled Machine over WebRTC. This is a programmatic capability with no menu,
button, or route in the UI. Web clients do not have a local forwarding API.

```text
Local browser / debugger / other TCP client
  -> 127.0.0.1:<local port>
  -> Desktop main process -> WebRTC DataChannel -> target daemon
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

`targetHost` defaults to `127.0.0.1`; only the exact literals `127.0.0.1` and `::1`
are accepted. `targetPort` is 1–65535. `localPort` defaults to zero, asking the OS
to choose an available port; an explicit port must be available. Local listeners
always bind `127.0.0.1`. The bridge validates parameters and accepts calls only
from the trusted main renderer. There is no automatic discovery, persistence,
UDP, reverse forwarding, or remote LAN destination support.

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

Native tests exercise real WebRTC peers and loopback sockets. Desktop tests
cover parameter validation, trusted-renderer access, native adaptation, and
cleanup of active and pending forwards. Signaling tests cover early ICE,
revocation, expiry, account changes, setup cancellation, and signaling outages.

The existing backend smoke workflow also exercises port forwarding through the
real owned-account/PostgreSQL backend and daemon, with concurrent binary streams, a
response after TCP half-close, explicit stop, and server revocation. Run it
directly and with a configured TURN service:

```sh
mise -E development run backend:smoke
DESKFLEET_SMOKE_RELAY_ONLY=1 mise -E development run backend:smoke
```

## Relation to external editors

[Issue #74](https://github.com/yet-another-ai/deskfleet/issues/74) requests opening
a Workspace or Session in an external editor. TCP forwarding supplies a
transport that a later editor adapter can use to reach an existing remote SSH
service. It does not implement an SSH server, SSH credentials, editor launching,
or selection of Workspace/Session directories. Local editor launching can be
implemented independently. This capability supports that issue without closing it.
