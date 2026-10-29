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
| Linux Wayland | RemoteDesktop + ScreenCast portal / PipeWire | GStreamer VA-API or NVENC H.264/H.265/AV1, subject to GPU/driver support | Unsupported |
| Linux X11 | RandR / GetImage with XFixes cursor | Same GStreamer hardware encoders as Wayland | Unsupported |

WebRTC DataChannels and Opus encoding work without a display. Loading the addon,
creating a peer does not enumerate displays or probe video encoders. On Linux,
daemon capability discovery checks the selected desktop backend and optional
hardware encoding runtime without requesting consent. `captureDisplays()`,
`supportedVideoCodecs(displayId)`, and `startDesktop()` are explicit operations. Capture requires an interactive
graphical session and any platform recording permission.

On Windows, capture creates its D3D11 device on the adapter that owns the
selected display. Codec discovery probes NVENC and Media Foundation on that
same display's adapter, without a global cache or a union of other GPUs' codecs.
The capability response attaches codecs to each display. Desktop Settings
shows the codec the viewer will use and updates it when the selected display
changes. The viewer picks the first codec in AV1, HEVC, H.264 order that both
that display and the browser can use. It does not offer a codec menu.
Encoding first tries NVENC on that device. If H.264 startup
fails, it tries hardware Media Foundation transforms on the same adapter.
There is no software encoder fallback. H.265 and AV1 remain NVENC-only.
Changing the negotiated codec requires a new peer. If the video encoder fails
while starting, while waiting for its first packet, or mid-session, the viewer
closes that peer and negotiates the next common codec. Permission, missing
display, ICE, and transport failures stop without another codec. The desktop
error event includes `reason: "encoder"` for the failures that may continue.
Older callers omit `reason`; those failures are not retried.

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

On macOS, the daemon owns Screen Recording and Accessibility consent through the
shared `DesktopPermissions` lifecycle. The desktop app starts its enabled hosted
daemon during startup, then the welcome page guides Full Disk Access,
Screen Recording, and Accessibility in order. In this guided mode, startup and
focus refreshes only check permissions; each explicit welcome action requests
one permission through authenticated local IPC. Standalone daemons request all
permissions independently once startup owns discovery and local IPC is ready.
The native checks and requests run on Rust workers, without starting capture or
initializing input. Screen Recording also covers the current ScreenCaptureKit
system-audio stream. Pending or denied permission does not block agents,
terminals, catalog operations, or daemon cleanup. Windows returns `not-required`
without prompting. Linux uses the backend-specific access checks described below
and does not require Full Disk Access.

### Linux desktop selection

`deskfleet-linux-desktop` selects one backend for native access, capture, and
input for the lifetime of the daemon process. `XDG_SESSION_TYPE=wayland` or a
nonempty `WAYLAND_DISPLAY` selects Wayland, including when `DISPLAY` also points
to Xwayland. Otherwise a nonempty `DISPLAY` selects X11. No graphical environment
means desktop access is unavailable. Restart the daemon after changing its
session environment. Failed Wayland authorization never falls back to Xwayland;
the X11 connection also rejects servers advertising the XWAYLAND extension.

The authenticated local `hello` and permission snapshots carry
`linuxDesktopBackend` (`wayland`, `x11`, or `null`). Wayland retains its two welcome
permission steps. X11 skips those Portal steps and silently checks the user's
X server access; successful checks report `not-required`. Connection errors
remain visible in Desktop Settings. Neither backend starts capture or input
while checking permissions.

### Wayland authorization and media

Linux supports the current user's logged-in, unlocked Wayland desktop through
RemoteDesktop portal v2, ScreenCast, PipeWire, and EIS. The portal backend must
support keyboard and pointer access and monitor capture; a ScreenCast-only
backend is insufficient. GNOME and KDE provide these interfaces. Login-screen
access, remote unlock, clipboard, and system audio are outside this backend.

After discovery and local IPC are ready, both standalone and Electron-hosted
daemons request screen and input access together. This runs asynchronously so a
pending dialog does not block other daemon work. The user selects the monitors
and grants access locally. `deskfleet-wayland` owns one shared portal session on
a dedicated runtime thread. Viewer disconnect and controller release keep that
session alive; daemon shutdown cancels pending consent and closes it.

The request uses `persist_mode=2` on `RemoteDesktop.SelectDevices`. A returned
opaque restore token is atomically saved as `<daemon directory>/wayland-restore-token`
with mode `0600`, and replaced by every successful Start response. The token
never enters central storage or peer messages. Subsequent daemon starts restore
it; explicit display discovery can also restore after the compositor closes a
session. Discovery issued while that consent dialog is still open waits for the
grant already in progress and then lists the resulting monitors. An active
session reconnect needs no prompt. Across session recreation,
unattended restoration depends on the portal retaining the grant: a revoked or
expired token may require local consent again. A saved token alone never reports
granted permission. Permission refresh only reads current state.

The D-Bus connection registers `io.github.yet_another_ai.deskfleet` before portal
calls. Linux desktop packaging uses the matching `.desktop` basename; standalone
launches create a hidden user desktop entry only when no installed entry exists.
Run the daemon as the logged-in user with the session bus and Wayland environment,
not as a root system service.

ScreenCast v6's `pipewire-serial` selects the PipeWire object when available;
older backends use the returned node ID. Public display IDs identify this live
portal generation and become invalid when it closes. Each viewer gets a new
`OpenPipeWireRemote` connection. ScreenCast dimensions are logical; encoding uses
the negotiated frame's pixel dimensions. EIS `mapping_id` associates a monitor
with its absolute-pointer region, including scaling and monitor offsets.
Without mapping IDs, pointer input is accepted only for one unambiguous absolute
region. Monitors that cannot be mapped stay capturable; a missing or failed
input connection does not cancel the portal grant. An explicit access request
retries that input connection while screen capture remains granted and remote
input is disconnected. Display listing reuses the session without retrying it.

`deskfleet-linux-media` loads GStreamer inside the native process on demand.
PipeWire samples are copied into Rust-owned BGRA frames before returning buffers
to the pool. Capture pacing leaves the newest sample in the bounded appsink queue
until the next frame is due, so the final update is delivered even when the
desktop becomes idle. GStreamer converts and uploads these frames to VA-API or NVENC;
there is no software encoder fallback. Linux probes H.264, H.265, and AV1
independently, requiring each codec's parser and a registered hardware encoder.
The viewer uses the existing AV1 → HEVC → H.264 preference among the codecs both
ends support. An encoder failure retains the existing fallback to a new peer
with the next common codec.

This path uses CPU copies, not DMA-BUF zero-copy. Hardware candidates are checked
with the first real frame. H.264 constrained baseline and H.265 Main produce
Annex B access units with parameter sets on keyframes; AV1 Main produces OBU
temporal units. Codec-specific settings disable frame reordering/lookahead so
an idle desktop can emit a frame immediately. Requested keyframes use the latest
retained frame. Portal closure invalidates capture and input; every bounded capture poll
checks the source generation so retained frames cannot outlive authorization.

One EIS connection belongs to the portal session and is retained between
controllers. The existing exclusive-controller rule, Team grants, input
DataChannel, normalized coordinates, physical key codes, and held-key cleanup
apply unchanged. Device removal releases that device's held state. An EIS
disconnect or stream error releases remote input and leaves the ScreenCast
session running for current viewers. The daemon publishes that change to
connected clients, so accessibility follows the live input connection while
screen capture stays granted. Changes received during consent or an older check
queue a fresh permission check after it settles, without requesting consent again.
Daemon shutdown ends that watch; a later daemon
in the same process watches again. An input controller never closes another
viewer's portal session. Portal closure still ends capture and input together.

### X11 capture and input

`deskfleet-x11` uses x11rb's Rust transport with the logged-in user's `DISPLAY`
and Xauthority credentials over a local Unix socket (`:N.S` or `unix:N.S`).
TCP and SSH-forwarded displays are unsupported. Connection, authentication,
and discovery have a shared two-second deadline: expiration interrupts the
socket and joins the watchdog, so an unresponsive X server cannot hold daemon
capability queries indefinitely. It requires an accessible X server with a
TrueColor root visual and XFixes for the default visible cursor.
RandR 1.3 enumerates active CRTCs, their refresh rates, and
root-relative monitor bounds; a server without active RandR outputs exposes its
root screen instead. Capture and input share those source IDs and bounds,
including multiple X screens. A monitor moving, resizing, disappearing, or a
root-size change invalidates that source; reconnect after refreshing displays.

Capture reads the selected root rectangle with GetImage and converts the server's
pixel layout to packed BGRA. When requested, XFixes supplies the cursor image for
compositing. Each stream owns a paced producer and one replaceable queued frame;
consumer polling honors its timeout, and stopping discards pending frames and
interrupts any outstanding capture reply before joining its producer.
This path has CPU copies and does not use MIT-SHM or XDamage. The BGRA frames feed
the same GStreamer hardware encoder and WebRTC pipeline as Wayland. X11 capture
does not require PipeWire, a Portal grant, libei, or Xlib initialization.

XTEST injects keys and mouse buttons. Physical DOM keys map through evdev to the
server's XKB key names, so the remote keyboard layout determines characters.
Pointer positions use the captured monitor's root-relative bounds. Pixel wheel
deltas accumulate into X11 wheel button steps. The existing exclusive-controller
and held-input cleanup rules apply; stale sources reject new input while held
keys and buttons can still be released. A server without the required input
extensions remains viewable. Input and capture connections belong to their
workers, not to a daemon-wide authorization session. Input events and held-state
cleanup each have a two-second transport deadline, so a stalled server cannot
hold the input worker's shutdown indefinitely. Release is best-effort if the
server stops responding or the connection is lost.

Run the daemon inside the user's X11 session with its display credentials.
This backend does not create an X server, provide remote login/unlock, or capture
system audio. Hardware encoding remains required for desktop streaming.

### Permission status and stream lifecycle

The authenticated `hello` response includes `fullDiskAccessPermission`,
`screenCapturePermission`, and `accessibilityPermission`.
`desktopPermissionsChanged` events publish the combined snapshot to connected
clients. While the Agent runs, Desktop Settings groups pending, denied, or failed
requests. Granted or unnecessary permissions have no notice; the Agent's running
status stays separate.
Previously denied access must be enabled in macOS System Settings under Privacy
& Security → Screen & System Audio Recording or Accessibility as appropriate;
requests open the relevant settings pane when consent remains denied. Restart
the app or standalone daemon if macOS requires a restart after granting access.
Reconnecting a client reads the existing daemon's status without requesting
again. Tests inject permission checks and requests so ordinary test runs do not
open OS dialogs.

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
Electron client and open **Remote control → Desktop**. Refresh capabilities if needed,
choose a display, then connect. The viewer selects AV1, then HEVC, then H.264
from the codecs that display and the browser share, and shows the choice as
status text. On macOS, the daemon process
needs Screen Recording permission; system audio can be enabled explicitly.
Windows supports NVENC video and the hardware H.264 fallback described above.
Linux Wayland and X11 support the negotiated AV1, HEVC, or H.264 video and optional
mouse/keyboard control. Wayland uses the local Portal grant; X11 uses access to
the existing X server.

The Electron main process reads discovery/authentication data and proxies a narrow
preload API. Calls are accepted only from the registered main renderer frame.
The renderer subscribes before negotiation, creates receive-only transceivers,
selects the first codec supported by Chromium and the native encoder, exchanges SDP/ICE,
and starts capture after the peer connects. Candidates received before the answer
are queued. A media track feeds a standard `<video>` via `srcObject`; Chromium
owns decoding, audio playback, scaling, and fullscreen. Raw frames never cross the
preload bridge. No native decoder or independent GPU window is added.

Disconnect, switching away from the Desktop tab, navigation away from the desktop
view, renderer reload/crash, and client exit release the corresponding media
session. Tab switches retain display and stream settings; returning to Desktop
does not reconnect automatically. Hiding the desktop view or ending its stream
also exits its fullscreen stage; an unsuccessful exit keeps the manual exit
control available when the view is shown. Closing the window to the
tray keeps the renderer and its current stream alive. Failed or timed-out
connections expose an error and can be retried. The renderer retains its sandbox
and denied capture permissions: capture belongs to the daemon.

Selected-machine desktop connections use central authorization and signaling,
including server-provided STUN/TURN configuration. The daemon checks the
`desktop:stream` grant before starting capture. Enabling input also requires
`desktop:control`, checked by both the server and daemon. Desktop grants issued
to authorized Team members currently carry both actions; a stream-only grant
cannot inject input.

## Mouse and keyboard control

Select **Mouse and keyboard control** before connecting to control the
selected display. Viewing is the default. Click the video to focus keyboard
input; the surrounding application keeps its normal keyboard behavior when the
video is not focused. The toolbar can pause/resume input without stopping the
video. Disconnect to change the control setting.

The viewer sends JSON events on the reliable, ordered `deskfleet-input`
DataChannel. `pointerMove` and `pointerButton` use normalized display coordinates
in [0, 1]; the viewer removes the video's letterboxing before mapping pointer
positions. Buttons follow DOM numbering (left, middle, right, back, forward).
`wheel` carries CSS pixel deltas (positive right/down), and `key` carries physical
`KeyboardEvent.code`, pressed state, and repeat. The remote keyboard layout
determines characters. Physical keys that the target cannot map are ignored without
releasing held input or disconnecting the stream. Malformed messages and OS injection
failures still fail the connection. Clipboard, text/IME composition forwarding, and operating
system shortcuts intercepted by the viewer's OS are outside this contract.
`releaseAll` releases only controls held by this controller.

`deskfleet-input` owns validation, held state and platform injection behind one
backend interface. Windows uses SendInput scan codes and physical virtual-desktop
coordinates; macOS uses CoreGraphics events and display bounds in points, including
Retina and displays with negative origins. Linux uses Wayland EIS or X11 XTEST
with shared capture-source coordinates. Native platform state lives on one
dedicated input thread; napi only forwards bounded messages asynchronously.
Loading the addon and viewing a desktop do not initialize input. One controller
per daemon process is allowed; additional peers may continue viewing.

The daemon starts input for the capture's selected display and sends `ready` only
after startup and DataChannel opening. If capture or input enablement fails, start
waits for peer cleanup before reporting the failure. Cleanup diagnostics preserve
the original encoder failure classification so codec fallback remains available.
Duplicate start requests are rejected without interrupting capture or input that
is already starting or running. Input arriving before enablement, without
a control grant, or with malformed fields fails the connection. Focus loss,
hidden pages, and pointer cancellation release held controls. Peer disconnect,
revocation, expiry, capture failure, and daemon shutdown release native state.
Desktop close acknowledges native cleanup before a client reconnects; overlapping
close requests wait for the same cleanup. Encoder fallback and manual reconnect
also wait for closure before acquiring another controller.

macOS requires Accessibility permission for the process hosting the daemon.
The desktop welcome flow requests it after Screen Recording; standalone daemons
request it during startup. Remote input
startup still checks current permission and reports denial without opening a consent dialog.
Screen Recording permission is separate. Windows injection follows SendInput's
integrity restrictions: it cannot control elevated applications from a lower
integrity process or operate the secure desktop. Wayland input uses the
authorized EIS devices and follows compositor restrictions.

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

Linux media libraries are optional at runtime: GStreamer 1.x core, app and video
libraries, GLib, `videoconvert`, `appsrc`, and `appsink`, plus at least one
available hardware codec and its parser. Wayland capture additionally requires
`pipewiresrc`; X11 capture uses the X protocol directly:

| Codec | VA-API factories | NVENC factories | Parser |
| --- | --- | --- | --- |
| H.264 | `vah264enc`, `vah264lpenc` | `nvh264enc`, `nvautogpuh264enc` | `h264parse` |
| H.265 | `vah265enc`, `vah265lpenc` | `nvh265enc`, `nvautogpuh265enc` | `h265parse` |
| AV1 | `vaav1enc`, `vaav1lpenc` | `nvav1enc`, `nvautogpuav1enc` | `av1parse` |

Factory availability depends on the installed GPU and driver; one codec's missing
plugin does not disable other codecs. The [VA-API](https://gstreamer.freedesktop.org/documentation/va/index.html)
and [NVENC](https://gstreamer.freedesktop.org/documentation/nvcodec/index.html)
plugins generally come from the distribution's GStreamer bad package, alongside
the base and PipeWire packages. The addon has no ELF dependency on
GStreamer, PipeWire, libei, or Xlib; EIS uses the Rust `reis` implementation and
X11 uses x11rb. Machines without the desktop runtime still load the addon and run data-only services.

`mise run check` covers Rust/TypeScript checks and tests, including two real
local WebRTC peers, binary/text DataChannel delivery, SDP profile and H.265
packetization checks, and Opus encode/decode roundtrips. Capture tests requiring
a screen or recording permission are ignored in ordinary runs.
Run the macOS capture and hardware-encoder tests on a graphical host with:

```sh
mise exec -- cargo test -p deskfleet-capture -- --ignored
mise exec -- cargo test -p deskfleet-encoder -- --ignored
```

Linux CI also runs the X11 capture and input integration tests against Xvfb,
without hardware encoding or a user desktop. Run the same checks locally with:

```sh
xvfb-run -a env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 mise exec -- cargo test -p deskfleet-x11 -p deskfleet-capture --locked x11_ -- --ignored --test-threads=1
```

These checks validate real X protocol capture, input, and stream cleanup. Real
Xorg multi-monitor layouts, display changes, cursor rendering, and GPU encoding
still need acceptance checks on the target desktop.

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

On a Linux graphical host with the runtime and GPU drivers installed, run:

```sh
mise exec -- cargo test -p deskfleet-linux-media --locked -- --ignored --nocapture
```

These tests copy a generated GStreamer frame, retain the last update of a burst
across paced reads, and check capture timeouts and stop handling. They also encode
a generated frame and an idle keyframe for every advertised codec. Both keyframes
must decode in fresh decoder pipelines, with increasing timestamps and correct
dimensions/pixels.
No desktop authorization is requested.

To send generated hardware-encoded video through WebRTC to Chromium, run each
codec explicitly:

```sh
DESKFLEET_SMOKE_HARDWARE=1 DESKFLEET_SMOKE_CODEC=av1 mise run desktop:smoke-media
DESKFLEET_SMOKE_HARDWARE=1 DESKFLEET_SMOKE_CODEC=h265 mise run desktop:smoke-media
DESKFLEET_SMOKE_HARDWARE=1 DESKFLEET_SMOKE_CODEC=h264 mise run desktop:smoke-media
```

This mode uses synthetic frames and opens no Portal dialog. A codec absent from
Chromium's receive capabilities is reported as skipped; advertised codecs that
fail hardware initialization or decoding fail the smoke test.

On the actual Wayland or X11 desktop, verify real screen decoding with:

```sh
DESKFLEET_SMOKE_CAPTURE=1 mise run desktop:smoke-media
```

This streams to a hidden Chromium window without saving screen pixels and
opens/releases the input controller twice without injecting keys or pointer
events. On Wayland it allows two minutes for local consent and uses temporary
token storage; on X11 it checks the current X server without opening a Portal
dialog. Monitor coordinate mapping and display changes require acceptance checks
on the target desktop. Wayland also needs persistent restoration across daemon
restarts and compositor revocation checks.
