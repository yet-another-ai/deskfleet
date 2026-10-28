# WebRTC key exchange and peer authorization

This document owns remote WebRTC identity, key exchange, and access
lifecycle. [Architecture](architecture.md) owns the component boundaries;
[backend scope](backend.md) places this work in the first backend release.
The native transport performs DTLS. Central identity binding is implemented in
the server's peer routes, with independent grant enforcement in the daemon's
`AuthorizedPeers` service and both client adapters.

## Trust model

The central service is trusted to authenticate users and enrolled machines,
authorize their connection, and deliver the correct SDP fingerprints to each
side over authenticated HTTPS/WSS. It binds the originating identity to the
submitted SDP. Each endpoint's WebRTC stack then verifies that the DTLS peer
possesses the private key for the certificate identified by that SDP.
This uses the trusted-signaling model described in
[RFC 8827, sections 4.1 and 4.3](https://www.rfc-editor.org/rfc/rfc8827.html#section-4.1).

DeskFleet-owned account sessions establish the application's user login; it does not automatically bind
that user to a DTLS certificate. DeskFleet's authenticated signaling supplies
that binding. The first release does not use the browser WebRTC identity-provider
API, manual fingerprint pairing, or an additional device-signature protocol.
It does not attempt to protect against a malicious central identity service.

Use the standard WebRTC handshake and encryption implemented by Chromium and
the native WebRTC stack. Do not add a separate application key exchange, shared
Team encryption key, or payload-encryption layer. The API service does not
terminate DTLS or generate, receive, or distribute its private traffic keys.
Central Agent history remains a separate, authorized plaintext storage path.

## Credentials and keys

| Material | Owner and purpose | Handling |
| --- | --- | --- |
| User login credentials/session | Client and API service authenticate a user and device | Used on the API/signaling connection; never sent to the target as an agent-supplied identity claim |
| Machine enrollment credential | Daemon authenticates its registered installation to the API service | Separate from user login and WebRTC certificates; kept on the machine |
| DTLS certificate and private key | Each endpoint's WebRTC stack authenticates that endpoint in the handshake | Generate for each new PeerConnection; keep private material inside the local stack, without export to signaling, history, or logs |
| SDP certificate fingerprint | Identifies the DTLS certificate expected from an endpoint | Bind to the authenticated offer/answer and target; it is not a secret or a bearer credential |
| ICE username fragment/password | ICE connectivity checks for a negotiation | Forward only in the protected signaling exchange; never use as application authorization |
| TURN credential | Authorizes relay allocation and use | Issue temporary relay credentials to authorized peers; keep them separate from machine credentials and application grants |
| Peer authorization record | Server-issued identity, target, purpose, actions, and expiry | Metadata delivered over authenticated signaling, not a new cryptographic key or a reusable bearer token |

Browser PeerConnections generate default certificates when none are supplied;
the browser API does not expose their private key material. DeskFleet keeps this
per-connection behavior and does not persist certificates for reuse.
[W3C RTCConfiguration](https://www.w3.org/TR/webrtc/#dom-rtcconfiguration-certificates)
and [RTCCertificate](https://www.w3.org/TR/webrtc/#rtccertificate-interface)
define these boundaries.

## Establishing a connection

The client is the offerer and the daemon is the answerer, matching the existing
Agent, terminal, and desktop transports.

1. The client requests a peer for a selected Team, target Machine, and transport
   purpose (`agent`, `terminal`, `desktop`, or `files`) through its authenticated API
   session. The server resolves the user/device, checks Team access, and selects
   the target's authenticated daemon connection. A request cannot supply its own
   trusted actor or expand its permissions.
2. The server allocates a unique `peerId` and an authorization record. It binds
   the server identity, Team, user login/device, optional source Machine, target
   Machine/catalog origin, purpose, permitted actions, issue time, and expiry.
   The initial expiry is at most 24 hours after authorization. `peerId` is
   distinct from Agent Session IDs and is never sufficient to claim ownership.
3. The client creates its PeerConnection, generates an offer, and submits that
   exact SDP under `peerId`. The server accepts it only from the record's
   authenticated client, binds its effective DTLS fingerprints to the record,
   and forwards it with the verified authorization context to the target daemon.
4. The daemon verifies that the server context names its enrolled Machine/Team,
   that the grant is current, and that the purpose/actions are supported. It
   creates a native peer with that immutable context, applies the offer, and
   returns its answer through its authenticated machine connection. The server
   binds the answer and its fingerprints to the same record and delivers it only
   to the originating client.
5. Both sides apply only descriptions delivered for that peer and relay trickled
   ICE candidates through the same authenticated routing. Check direction and
   peer ownership, and resolve the candidate's transport using the bound SDP
   and media section/index. Validate an ICE username fragment when provided;
   when absent, associate it with this peer's single accepted negotiation.
   The native adapter normalizes empty `mid` placeholders using that mapping.
   Buffer candidates arriving before their description within that peer; never
   reuse a queue for a replacement peer. This accommodates the optional fields
   in [addIceCandidate](https://www.w3.org/TR/webrtc/#dom-peerconnection-addicecandidate).
6. ICE selects a path. The endpoints perform DTLS and their stacks verify the
   certificates against the fingerprints in the authenticated remote SDP. A
   mismatch fails the connection; no application traffic is admitted through an
   unverified peer. Certificate proof occurs here, not at the signaling server.
7. The daemon admits the negotiated channel/media operations under the bound
   authorization. Agent commands receive the verified actor from this context;
   request bodies, ACP `_meta`, and DataChannel labels cannot replace it.

The signaling record covers the complete offer and answer, including every
effective fingerprint for negotiated DTLS transports. Require SHA-256
fingerprints for the initial supported stacks. Parse SDP with its session/media
inheritance and transport mapping; do not authenticate a separately supplied
fingerprint while accepting unrelated SDP. SDP fingerprint semantics are defined
in [RFC 8122](https://www.rfc-editor.org/rfc/rfc8122.html#section-5).
The browser reports certificate mismatch as
[fingerprint-failure](https://www.w3.org/TR/webrtc/#dom-rtcerror-fingerprint-failure).

Use a single offer/answer exchange per `peerId` in the first release. An exact
retry by its owner can retrieve the same negotiation result; changing the offer,
answer, actor, target, or purpose cannot mutate an established binding. A failed
or replacement connection uses a new `peerId`, new authorization, and new
PeerConnections. In-place renegotiation/ICE restart is not required for this
release. Pending setup still has an ordinary connection timeout, independently
of the 24-hour authorization ceiling.

## Transport encryption and TURN

Agent and terminal DataChannels carry SCTP over DTLS. Desktop media uses SRTP/
SRTCP keys established by DTLS-SRTP. The stacks derive traffic keys during the
handshake; SDP carries certificate fingerprints and ICE parameters, not those
keys. See [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-5) and
[RFC 5764](https://www.rfc-editor.org/rfc/rfc5764.html#section-4.2).

TURN forwards the already protected peer packets and is not a DTLS endpoint.
Relay credentials authorize relay use, not Session access or decryption.
Use the same identity checks for direct and relayed paths; a relay-only test
must exercise the actual peer protocol. Relay allocation and refresh follow
[RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html), independently of the
application grant's expiry. Refreshing a relay allocation does not extend
DeskFleet authorization.

## Authorization lifetime and revocation

A peer grant ends when the peer closes, the server explicitly revokes it, or its
24-hour maximum lifetime expires, whichever happens first. Store `issuedAt` and
`expiresAt` in the immutable context. Normal login-token refresh, signaling
reconnection, and traffic activity do not extend that deadline. Login credentials
are revalidated when creating a replacement peer; first-release renewal uses
a new authorized PeerConnection rather than changing an existing grant.

The daemon enforces expiry and revocation, closes the peer and its subscriptions,
and rejects further operations. A client timer improves the UI but is not the
authority. Enforcement includes idle peers and outgoing terminal/media/history
streams, not only the next inbound command. Recheck expiry when handling work
after a suspended machine wakes.

Server logout invalidates peers issued under that application login session.
Removing a Team member invalidates their peers in that Team; removing a machine
invalidates peers targeting that machine. Revocation notices travel over the
authenticated daemon control connection and are applied when received. If that
connection is unavailable, delivery is delayed until reconnection; the local
24-hour deadline still bounds the old grant. On reconnect, reconcile surviving
peers with current authorization before restoring their signaling routes, closing
any that are revoked or expired. A surviving peer cannot be rebound to another
user or machine.

Loss of signaling alone does not close an established, functioning peer with an
unexpired grant. It can continue operations already covered by that grant;
new grants and HTTPS management requests still require the server. This does
not create a separate offline account or enrollment mode. Peer ownership and
expiry enforcement must outlive a particular WebSocket connection.

Expiration or revocation disconnects access; it does not cancel an already
accepted Agent task, terminate a shell, or archive/delete a Session. Terminal
controllers detach, provider execution and daemon history continue, and pending
approvals are not implicitly granted. Archive still has its own explicit
resource-closing semantics.

Ports peers separately require `ports:forward` before the daemon enables the
native TCP responder. Forwarding accepts only literal `127.0.0.1` or `::1`
destinations with a nonzero port. A connected peer or a `deskfleet-ports` channel
label alone never enables that responder. The native byte path checks the
grant's absolute expiry independently of the JavaScript event loop; revocation
closes the peer and all its sockets. Desktop listeners bind only `127.0.0.1`.
This grants access to Machine loopback services, not a Workspace network sandbox.
See [TCP forwarding](ports.md) for ownership and flow control.

Files peers separately require `files:read` or `files:write` on each operation and
outgoing response. Closing a files peer aborts its unfinished destination staging;
committed files remain. The application owns the transfer queue independently of
Agent and desktop viewers. See [files and transfers](files.md).

## Storage and implementation boundaries

Keep negotiation SDP and ICE data only in bounded connection/setup state as
needed. Do not put SDP, ICE passwords, TURN secrets, machine credentials, or
private key material in the Agent journal or application request logs. Connection
audit can retain actor, target, purpose, timestamps, expiry, and outcome.
Because authenticated server channels already carry the binding, no independent
SDP signature/JWT verification subsystem is needed for this trust model.

| Boundary | Implementation responsibility |
| --- | --- |
| [Native peer](../../crates/native/src/rtc/mod.rs) uses default certificate generation and standard remote SDP processing | Preserve stack-owned key generation and fingerprint verification; do not disable verification or expose private keys through napi |
| [Generated control protocol](../../crates/protocol/control.ts) carries authenticated peer context | Keep central peer identity, immutable description binding, and expiry separate from resource IDs |
| [Authorized peers](../../apps/daemon/src/authorized-peers.ts) owns remote access | Bind terminal access and Agent actors to daemon-owned authorization/lifetime state |
| [Remote client adapter](../../packages/client/src/remote.ts) tracks signaling and grants | Distinguish signaling availability from RTC failure and explicit revocation; preserve working peers within their grant |
| [Agent journal actor](../../apps/daemon/src/agent-store.ts) records the authorized caller | Supply verified user/device identity from the bound peer, with source Machine absent for browsers that have none |
| [Native ICE configuration](../../crates/native/src/rtc/types.rs) already supports servers and relay-only policy | Pass authorized server-provided ICE configuration to both endpoints |

The locked native dependency generates a certificate for each default
PeerConnection and checks the remote handshake certificate against its SDP
fingerprint. The server and daemon implement authenticated identity binding,
operation authorization, and connection lifecycle around that transport.
Local discovery tokens remain local transport credentials and cannot authorize
remote grants.

## Acceptance

- Electron and Web establish Agent and terminal peers through authenticated
  signaling, both directly and through forced TURN. Verify the existing media
  transport uses the same binding without expanding desktop-control scope.
- A changed fingerprint fails the assembled connection. Missing or unsupported
  fingerprints and mismatched SDP/context are rejected before domain traffic.
- Another user's `peerId`, a different target/Team, a wrong-purpose channel, and
  stale answer/candidate messages cannot acquire or broaden access.
- Agent audit attributes the verified user/device even if `_meta` claims a
  different identity. Terminal permissions survive a signaling reconnect only
  under the same valid peer context.
- Signaling loss leaves a valid working peer usable. Explicit revocation or
  24-hour expiry closes access, including outbound streams, without stopping
  Agent tasks or shells. Use a controlled clock to exercise the expiry boundary.
- Signaling reconnect does not reset expiry; a replacement peer requires current
  authorization and fresh key establishment, and restores history without
  replaying accepted commands.
- Operational logs and synchronized history contain no handshake/relay secrets
  or private keys. No test needs to reimplement or retest the cryptographic
  primitives supplied by the WebRTC stacks.
