# Native WebRTC and media

The transport and media implementation is adapted from
[`dsh0416/desk-fleet`](https://github.com/dsh0416/desk-fleet) at
`e4b963274b4afae8a7b8065d9efe5c6770bf9339`: its `rust/capture`, `rust/encoder`,
`rust/nvenc`, `rust/nvenc-sys`, and `rust/streamer` code. The original streamer's
process and JSON-RPC service are replaced by reusable Rust APIs and a thin
napi-rs boundary. The TypeScript daemon owns peer sessions.

## Transport

`deskfleet_native::rtc::Peer` uses `webrtc-rs` 0.17. Each peer owns its connection,
optional video/Opus tracks, DataChannels, and RTCP reader tasks. The API accepts
ICE servers and credentials from the signaling caller, including TURN and a
relay-only policy. No public STUN server or credentials are hardcoded.

Offer/answer operations begin trickle ICE. Consume `nextEvent()` and forward
`iceCandidate` events through the signaling service. Apply remote candidates
after installing the remote description. `iceGatheringComplete` marks local
completion. Events also report state changes, channel open/close, binary/text
messages, keyframe requests, and errors. The queue holds 256 events and reports
an overrun when full. One consumer owns each peer's event loop.

DataChannels are ordered and reliable. Messages are limited to 64 KiB and each
channel has a 1 MiB buffered-send budget. A full buffer is an explicit error;
callers must pace/chunk larger terminal or operation results. Default RTCP
interceptors handle reports and retransmission. PLI/FIR requests and connection
establishment request encoder keyframes.

The H.265 RTP payloader and sample track are carried over from the old project.
Video uses H.264 constrained baseline, H.265 Main, or AV1 Main, selected before
negotiation. H.264/H.265 input is Annex B; AV1 is an OBU stream. Encoders select
levels automatically; resolution/frame-rate adaptation to the remote decoder's
level and congestion-driven bitrate control are not implemented. Callers must
choose settings the receiving device can decode. The Electron/browser WebRTC
stack owns receive-side decoding and playback.

## Capture and encoding

| Platform | Capture | Video encoder | System audio |
| --- | --- | --- | --- |
| macOS | ScreenCaptureKit / IOSurface | VideoToolbox H.264/H.265/AV1, subject to runtime support | ScreenCaptureKit → Opus |
| Windows | DXGI Desktop Duplication / D3D11 | NVIDIA NVENC H.264/H.265/AV1, subject to GPU/driver support | Unsupported |
| Linux | Unsupported | Unsupported | Unsupported |

WebRTC DataChannels and Opus encoding work without a display. Loading the addon,
creating a peer, or starting the daemon does not enumerate displays or probe
video encoders. `captureDisplays()`, `supportedVideoCodecs()`, and
`startDesktop()` are explicit operations. Capture requires an interactive
graphical session and any platform recording permission.

On macOS, the daemon requests Screen Recording consent as soon as startup owns
discovery and local IPC is ready. `requestScreenCaptureAccess()` checks existing
consent and requests it through CoreGraphics on a Rust worker; it does not start
capture. This consent also covers the current ScreenCaptureKit system-audio
stream. Waiting for or denying consent does not block agents, terminals, catalog
operations, or daemon cleanup. Windows and Linux do not issue this request.

The authenticated `hello` response includes `screenCapturePermission`, and
`screenCapturePermissionChanged` events publish the result to connected clients.
While the Agent runs, Desktop Settings shows pending, denied, or failed permission
requests. Granted or unnecessary permissions have no notice; the Agent's running
status stays separate.
Previously denied access must be enabled in macOS System Settings under Privacy
& Security → Screen & System Audio Recording; restart the local Agent afterward.
Reconnecting a client reads the existing daemon's status without requesting again.
Tests inject the permission request so ordinary test runs do not open OS dialogs.

The native desktop pipeline owns capture and hardware encoding on one blocking
worker, preserving D3D11 thread ownership and retained GPU surface lifetimes.
Raw frames stay in Rust. Encoded packets enter a bounded queue of eight packets
and one async task delivers them in order. Shutdown closes delivery before
joining capture, unblocking a producer waiting on a full queue. `stopDesktop()`
and `close()` report worker failures; the event loop also receives media errors.
`startDesktop()` resolves after the first captured frame is submitted to the
encoder successfully. Dropping a stream also cancels its work.

Desktop options select a display, frame rate, average bitrate, and optional
maximum bitrate. Frame rate is capped at the display's refresh rate when known.
Codec and audio are chosen when creating the peer. Stop the stream before
restarting with changed desktop settings; create a new peer to change codecs.

## Daemon integration

`startDaemon()` returns `peers: PeerSessions`. The CLI also starts an authenticated
local control socket (Unix-domain socket or Windows named pipe). Its private
`~/.deskfleet/daemon.json` discovery record contains the endpoint and a random
per-run token; `DESKFLEET_DAEMON_DIRECTORY` overrides the directory for both daemon
and Electron. A live daemon prevents a second process from replacing its record.
The health endpoint remains read-only and does not expose signaling or capture.

The local contract in `apps/daemon/src/control-protocol.ts` carries authentication,
capability discovery, SDP offers/answers, trickle ICE, capture start, close, and
session events. The daemon assigns native peer IDs internally; each socket can
operate only on its own sessions. Disconnect releases those peers and capture
workers. Agent sessions and the daemon remain running. Daemon shutdown closes
all peers, including pending creation.

## Electron playback

Start `mise run daemon:dev` and `mise run desktop:dev` in separate terminals. Open
**Remote desktop** under the real local machine, refresh capabilities if needed,
choose a display and a common codec, then connect. The local target is separate
from the sample catalog and is not an enrolled machine identity. Remote sample
machines cannot start local capture. On macOS, the daemon process needs Screen
Recording permission; system audio can be enabled explicitly. Windows currently
supports video on NVIDIA hardware. Linux capture is unavailable.

The Electron main process reads discovery/authentication data and proxies a narrow
preload API. Calls are accepted only from the registered main renderer frame.
The renderer subscribes before negotiation, creates receive-only transceivers,
selects a codec supported by Chromium and the native encoder, exchanges SDP/ICE,
and starts capture after the peer connects. Candidates received before the answer
are queued. A media track feeds a standard `<video>` via `srcObject`; Chromium
owns decoding, audio playback, scaling, and fullscreen. Raw frames never cross the
preload bridge. No native decoder or independent GPU window is added.

Disconnect, navigation away from the desktop view, renderer reload/crash, and
client exit release the corresponding media session. Closing the window to the
tray keeps the renderer and its current stream alive. Failed or timed-out
connections expose an error and can be retried. The renderer retains its sandbox
and denied capture permissions: capture belongs to the daemon.

The UI uses local signaling and direct ICE without STUN/TURN. Central server
authentication/signaling, remote machine discovery, client TURN configuration,
and desktop keyboard/mouse input are not integrated.

The native package can also be used directly:

```ts
import { createPeer } from "@deskfleet/native"

const peer = await createPeer({
  video: "h264",
  audio: false,
  iceServers: [{ urls: ["stun:stun.example.org:3478"] }],
})
try {
  // Exchange SDP and ICE over the authenticated signaling connection.
  // Start capture after authorizing desktop access and selecting a display.
  await peer.startDesktop({ displayId: 1, fps: 30, bitrateBps: 8_000_000 })
} finally {
  await peer.close()
}
```

## Builds and checks

The locked CMake 4.4 toolchain builds the bundled Opus source. Cargo forces
static Opus linkage and bypasses pkg-config so the SEA addon does not depend on
a separately installed libopus. Windows NVENC loads the NVIDIA driver at runtime;
building its bundled header bindings requires LLVM/libclang and the Windows SDK.
CI sets `LIBCLANG_PATH` to the hosted runner's LLVM installation. No NVIDIA SDK
binary is redistributed.

`mise run check` covers Rust/TypeScript checks and tests, including two real
local WebRTC peers, binary/text DataChannel delivery, SDP profile and H.265
packetization checks, and Opus encode/decode roundtrips. Capture tests requiring
a screen or recording permission are ignored in ordinary runs.
Run them on a graphical host with:

```sh
mise exec -- cargo test -p deskfleet-capture -- --ignored
mise exec -- cargo test -p deskfleet-encoder -- --ignored
```

`mise run desktop:smoke-media` uses a test-only native sender and a small generated
H.264 fixture to exercise Chromium negotiation and video decoding without screen
capture. TURN service connectivity, GPU/driver combinations, and physical
screen/audio capture need integration testing on the target devices.
