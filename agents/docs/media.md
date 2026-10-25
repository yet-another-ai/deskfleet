# Native WebRTC and media

The transport and media implementation is adapted from
[`dsh0416/desk-fleet`](https://github.com/dsh0416/desk-fleet) at
`e4b963274b4afae8a7b8065d9efe5c6770bf9339`: its `rust/capture`, `rust/encoder`,
`rust/nvenc`, `rust/nvenc-sys`, and `rust/streamer` code. The original streamer's
process and JSON-RPC service are replaced by reusable Rust APIs and a thin
napi-rs boundary. The TypeScript daemon owns peer sessions.

## Transport

`deskfleet_native::rtc::Peer` uses `webrtc-rs` 0.21.1 and its `rtc` Sans-I/O core.
Each peer owns its connection, optional video/Opus tracks, DataChannel event
readers, and RTCP reader tasks. The API accepts
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

The 0.21 transport resolves mDNS candidates before matching incoming STUN
responses and keeps receiving after recoverable UDP errors, including Windows
`WSAECONNRESET` during ICE checks. These fixes replace the legacy 0.17 transport;
no local ICE dependency patch is required.

The H.265 RTP payloader is carried over from the old project to support mixed
three- and four-byte Annex B start codes. The sample track uses the negotiated
payload type and validates the encoded codec profile with the new sender API.
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
| Windows | DXGI Desktop Duplication / D3D11 | NVENC H.264/H.265/AV1; Media Foundation hardware H.264 fallback, subject to GPU/driver support | Unsupported |
| Linux | Unsupported | Unsupported | Unsupported |

WebRTC DataChannels and Opus encoding work without a display. Loading the addon,
creating a peer, or starting the daemon does not enumerate displays or probe
video encoders. `captureDisplays()`, `supportedVideoCodecs(displayId)`, and
`startDesktop()` are explicit operations. Capture requires an interactive
graphical session and any platform recording permission.

On Windows, capture creates its D3D11 device on the adapter that owns the
selected display. Codec discovery probes NVENC and Media Foundation on that
same display's adapter, without a global cache or a union of other GPUs' codecs.
The capability response attaches codecs to each display, and Desktop Settings
updates its codec choices when the selected display changes.
Encoding first tries NVENC on that device. If H.264 startup
fails, it tries hardware Media Foundation transforms on the same adapter.
There is no software encoder fallback. H.265 and AV1 remain NVENC-only;
changing the negotiated codec requires a new peer.

The Media Foundation backend converts BGRA to limited-range BT.709 NV12 on the
GPU and supplies retained D3D11 textures to the asynchronous hardware encoder.
It requires a D3D11-aware H.264 hardware MFT and a compatible video processor.
It uses bounded input buffering, low-latency settings, and requested keyframes.
An unsupported optional force-keyframe property is logged without aborting frame
submission. The capture worker retains the latest owned frame so PLI/FIR can
request a new keyframe even when the desktop stops changing; repeated submissions
receive increasing timestamps. At most four MF inputs are in flight and one
latest sample waits for input capacity.
Enumeration reports candidate codec support; starting the selected display's
stream verifies its actual device, dimensions, and profile.

For diagnostics, set `DESKFLEET_WINDOWS_ENCODER` in the daemon's environment to
`auto` (default), `nvenc`, or `media-foundation` before starting the process.
An explicit backend never falls back to another encoder. `media-foundation`
advertises only H.264. This also allows testing MF on a machine with NVENC.

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
`startDesktop()` resolves after the first nonempty encoded video packet enters
delivery. The worker polls asynchronous encoder output even when the desktop
has not changed. Dropping a stream also cancels its work.

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

After login and machine enrollment, select the target machine in the Web or
Electron client and open **Remote desktop**. Refresh capabilities if needed,
choose a display and a common codec, then connect. On macOS, the daemon process
needs Screen Recording permission; system audio can be enabled explicitly.
Windows supports NVENC video and the hardware H.264 fallback described above.
Linux capture is unavailable.

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

Selected-machine desktop connections use central authorization and signaling,
including server-provided STUN/TURN configuration. The daemon checks the
`desktop:stream` grant before starting capture. Desktop keyboard/mouse input
is not implemented.

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

The locked CMake 4.4 toolchain builds the bundled Opus source. Opus 0.4 uses
`opusic-sys`'s bundled static library by default, so the SEA addon does not depend
on a separately installed libopus. Windows NVENC loads the NVIDIA driver at runtime;
building its bundled header bindings requires LLVM/libclang and the Windows SDK.
CI sets `LIBCLANG_PATH` to the hosted runner's LLVM installation. No NVIDIA SDK
binary is redistributed.

`mise run check` covers Rust/TypeScript checks and tests, including two real
local WebRTC peers, binary/text DataChannel delivery, SDP profile and H.265
packetization checks, and Opus encode/decode roundtrips. Capture tests requiring
a screen or recording permission are ignored in ordinary runs.
Run the macOS capture and hardware-encoder tests on a graphical host with:

```sh
mise exec -- cargo test -p deskfleet-capture -- --ignored
mise exec -- cargo test -p deskfleet-encoder -- --ignored
```

`mise run desktop:smoke-media` uses a test-only native sender and a small generated
H.264 fixture to exercise Chromium negotiation and video decoding without screen
capture. TURN service connectivity, GPU/driver combinations, and physical
screen/audio capture need integration testing on the target devices.

On an interactive Windows host, explicitly exercise MF hardware encoding and
decode a real desktop stream in Chromium (PowerShell):

```powershell
$env:DESKFLEET_WINDOWS_ENCODER = "media-foundation"
mise exec -- cargo test -p deskfleet-encoder --locked windows_hardware_encodes -- --ignored --nocapture
$env:DESKFLEET_SMOKE_CAPTURE = "1"
mise run desktop:smoke-media
Remove-Item Env:DESKFLEET_SMOKE_CAPTURE
Remove-Item Env:DESKFLEET_WINDOWS_ENCODER
```

The hardware test submits a single retained desktop frame, waits for output
without another input, and checks a requested keyframe and timestamps. Capture
smoke mode validates real H.264 decoding without saving screen pixels to disk;
the default smoke remains the generated fixture. Run again with `nvenc` to
check the existing path. Intel/AMD and non-default-adapter displays require
corresponding hardware; success on one GPU does not validate other drivers.
