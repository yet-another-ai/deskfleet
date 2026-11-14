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
levels automatically. Resolution and frame-rate adaptation to the remote
decoder's level are not implemented; callers must choose settings the receiving
device can decode. Sending video peers enable webrtc-rs send-side congestion
control (GCC with TWCC feedback and a pacer). The estimator's target bitrate
drives live hardware-encoder retargeting, clamped to the stream's configured
ceiling (default 8 Mbps). Windows NVENC uses live session reconfiguration when the device supports it.
An unsupported device recreates once at the requested target, with capture
backpressure preventing a growing send queue. The browser WebRTC stack owns receive-side decoding and
playback for the embedded viewer. The optional
[native desktop window](#native-desktop-window) uses the Rust receive path.

`Peer::new_video_receiver()` creates a receive-only video transceiver without
adding a sending video track. Its single `VideoReceiver` consumer reads complete
RTP datagrams and can request PLI refreshes. Closing the owning peer cancels
reads, including while waiting for the first remote track. Packet reordering,
depacketization, and decoding belong to the receiving media pipeline; the
transport does not discard compressed reference pictures to follow presentation
backpressure.

## Display names and numbers

Capture IDs are opaque routing identifiers, not user-facing monitor numbers.
Windows uses an `HMONITOR` handle and Wayland allocates a new ID for every
authorized source generation. Preview cards and both viewers use separate
optional `name` and `displayNumber` metadata, falling back to the current list's
one-based ordinal. Selecting a label still sends the original capture ID.

Windows joins active DisplayConfig targets to the GDI source name and exposes
the friendly monitor name with its GDI device label. Its display number comes
from `DISPLAYn`, with an enumeration fallback. These numbers identify Windows
outputs and are not a promise of permanent physical identity. X11 forwards its
existing RandR output name.

Wayland keeps monitor presentation metadata in its native authorization owner.
KDE output names and unambiguously matched GNOME DisplayConfig monitors can
retain their user-facing numbers across authorization resets. The local number
mapping (`wayland-monitor-numbers.json` in the daemon directory) is independent
of the restore token and never authorizes capture or input. GNOME matching uses
the logical layout, scale, and transform; ambiguous
or mirrored matches keep a generic label. Metadata lookup or storage failures
must not discard an otherwise valid Portal grant. A missing identity falls back
to a current-list number. The generic Portal stream ID is scoped to restoration
and is not treated as a permanent physical monitor identifier.
GNOME identities include the connector and hardware tuple; KDE identities use
the output name. Changing ports or docks may therefore assign a new number.

## Capture and encoding

| Platform | Capture | Video encoder | System audio |
| --- | --- | --- | --- |
| macOS | ScreenCaptureKit / IOSurface | VideoToolbox H.264/H.265/AV1, subject to runtime support | ScreenCaptureKit → Opus |
| Windows | DXGI Desktop Duplication / D3D11 | NVENC H.264/H.265/AV1; Media Foundation hardware H.264/H.265/AV1 fallback, subject to GPU/driver support | Unsupported |
| Linux Wayland | RemoteDesktop + ScreenCast portal / PipeWire | GStreamer VA-API or NVENC H.264/H.265/AV1, subject to GPU/driver support; optional x264 H.264 software fallback | Unsupported |
| Linux X11 | RandR / GetImage with XFixes cursor | Same GStreamer encoders as Wayland | Unsupported |

WebRTC DataChannels and Opus encoding work without a display. Loading the addon,
creating a peer does not enumerate displays or probe video encoders. On Linux,
daemon capability discovery checks the selected desktop backend and optional
video encoding runtime without requesting consent. `captureDisplays()`,
`supportedVideoCodecs(displayId)`, and `startDesktop()` are explicit operations. Capture requires an interactive
graphical session and any platform recording permission.

On Windows, capture creates its D3D11 device on the adapter that owns the
selected display. Codec discovery probes NVENC and Media Foundation on that
same display's adapter, without a global cache or a union of other GPUs' codecs.
The capability response attaches codecs to each display. Desktop Settings
shows the codec the viewer will use and updates it when the selected display
changes. The viewer picks the first codec in AV1, HEVC, H.264 order that both
that display and the browser can use. It does not offer a codec menu.
Encoding first tries NVENC on that device. If NVENC startup
fails, it tries hardware Media Foundation transforms for the same codec on the
same adapter. There is no software encoder fallback.
Changing the negotiated codec requires a new peer. If the video encoder fails
while starting, while waiting for its first packet, or mid-session, the viewer
closes that peer and negotiates the next common codec. Permission, missing
display, ICE, and transport failures stop without another codec. The desktop
error event includes `reason: "encoder"` for the failures that may continue.
Older callers omit `reason`; those failures are not retried.

The shared source waits up to 30 seconds for its first nonempty video packet
after capture has opened, allowing asynchronous hardware encoders time to warm
up. Viewers await this source-wide startup result before starting their own
30-second first-keyframe delivery deadline. Joining an already producing source
starts that viewer deadline immediately. A viewer deadline is a transport failure
and does not trigger codec fallback; actual source startup and encoder failures
retain their classification for every attached viewer.
Audio produced before the first video packet is discarded so it cannot fill the
broadcast while viewers wait for video readiness.
Local desktop-start and close IPC allow 45 seconds for startup and cleanup;
the browser and native viewers give connection setup 45 seconds, then start a
separate 45-second media-start deadline when requesting capture on the connected
peer. Time spent negotiating SDP/ICE does not consume the encoder's startup
window or mask its failure classification and codec fallback. After the first
packet, a gap in encoder output alone does not fail the stream. Explicit capture,
encoder, and transport errors still end it and retain their error classification.

Windows NVENC uses P3 with ultra-low-latency tuning and CBR for H.264, HEVC,
and AV1. B-frames, lookahead, and temporal AQ are explicitly disabled; the
infinite GOP and on-demand keyframes remain unchanged. The preset's VBV and
multipass settings are retained. Spatial AQ remains disabled: a synthetic
scrolling-text comparison on an RTX 4090 showed that spatial AQ and a one-frame
VBV budget reduced text fidelity, especially on the first frame. An idle
desktop does not continuously re-encode, so that first image must stand on its
own. P3 modestly improved quality over P1 in that comparison, while P4 added
encoding time for little further benefit. This is a workload-specific choice
within the [NVENC tuning controls](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html#encoder-tuning-info-and-preset-configurations);
other GPUs and content still need measurement. Linux's GStreamer encoder
configuration is separate.

The Media Foundation backend converts BGRA to limited-range BT.709 NV12 on the
GPU and supplies retained D3D11 textures to the asynchronous hardware encoder.
It requires a D3D11-aware H.264, H.265, or AV1 hardware MFT and a compatible
video processor.
It uses bounded input buffering, low-latency configuration, and requested keyframes.
An unsupported optional force-keyframe property is logged without aborting frame
submission. The capture worker retains the latest owned frame so PLI/FIR can
request a new keyframe even when the desktop stops changing. Repeated submissions
receive increasing timestamps. At most four MF inputs are in flight and one
latest sample waits for input capacity.
Polling keeps these bounded samples through gaps in hardware output, without an
output inactivity deadline. Explicit flush/drain operations remain time-bounded.
Codec discovery opens a probe session on the display adapter. Starting the
stream for the selected display makes sure that its dimensions and bitstream
headers match the configuration.

For diagnostics, set `DESKFLEET_WINDOWS_ENCODER` in the daemon's environment to
`auto` (default), `nvenc`, or `media-foundation` before starting the process.
An explicit backend never falls back to another encoder. `media-foundation`
advertises the codecs that have a working hardware MFT on the display adapter.
This also allows testing MF on a machine with NVENC.
With the Windows desktop service installed, this diagnostic setting belongs to
the service's environment; changing only the user daemon's environment does not
change the service workers' encoder selection.

### Windows locked-desktop access

The Windows welcome page and Settings → Permissions → **Remote control while
locked** install the optional `DeskFleetDesktop` Windows service after explicit
administrator approval. Welcome checks service status silently and uses the same
installation controller as Permissions. Users can skip the step or retry after
canceling approval; completed setup is not repeated. The NSIS app
remains a per-user installation. The service and its desktop workers run from
`Program Files/DeskFleet Desktop Service/deskfleet-desktop-service.exe`, with
write access restricted to administrators and SYSTEM. No additional display or
input driver is installed.

When installed, display discovery, codec probing, capture/encoding, and input use
the service. A missing service preserves the user-process backend. A stopped or
failed installed service is reported as an error rather than silently selecting
a backend that cannot access the lock screen. The native media pipeline is shared
between both modes. Frames remain in Rust; only encoded packets cross a bounded
named-pipe protocol before the user daemon sends them over its existing WebRTC peer.
Video encoder errors retain the normal codec-fallback classification.

The service accepts local pipe clients only. It checks the caller's token SID and
OS session against the logged-in physical console user, then starts a SYSTEM
worker in that session. Client connections verify the broker PID against Windows
SCM and the worker PID against the broker's reply. Worker pipes restrict access
to SYSTEM and the console owner, require a per-worker secret, and continuously
recheck console ownership. Logout or switching to another OS user closes that
access. The service is a desktop capability for the local OS user; Team grants
remain enforced by the user daemon before accepting remote desktop operations.
It offers no file, process-launch, or network-forwarding RPC.

Capture and input threads bind to the current input desktop. Input requests
`DESKTOP_JOURNALPLAYBACK` on its desktop handle so Windows accepts `SendInput`;
capture does not require that right. A desktop change
invalidates old captured surfaces and encoder output, recreates duplication, and
requests a fresh keyframe. Input refresh releases held controls across desktop
changes, including while no new input arrives. Closing a peer closes its worker
connection; service shutdown signals workers to clean up before terminating any
that fail to exit. The existing exclusive-controller rule remains per daemon.

The supported scope is the same already-logged-in console session: connecting
while locked and continuing through lock/unlock. A logged-out machine, another
user's desktop, RDP-only sessions, and displays absent from Windows are outside
this path. The Electron app or standalone user daemon must remain running.

Windows controllers have a **Send Ctrl+Alt+Del** toolbar action when capability
discovery reports a running service and policy that permits software SAS. It sends the
explicit `secureAttention` input event after releasing remote held keys. The
service calls Windows `SendSAS` for the authenticated console session. Existing
`SoftwareSASGeneration` policy must allow services (value 1 or 3); a disallowed
policy is reported as an error. DeskFleet does not modify this machine policy.

Validate this path on Windows hardware with a working DXGI display and hardware
encoder; a Linux cross-build does not exercise Winlogon, UAC, SCM, or GPU desktop
switches. Install the packaged app, enable the setting, and use a second client:

1. Connect with control, move the pointer and hold and release a modifier. Lock
   the host, enter its password remotely, and verify capture and input continue
   after unlock.
2. Disconnect, lock the host locally, and create a fresh viewer/control peer.
   Confirm display/codec discovery and the first frame work while locked.
3. Exercise Ctrl+Alt+Del with service-allowed SAS policy. With disallowed policy,
   confirm fresh capability discovery hides the action. If policy changes after
   discovery, the action must report the failure without changing Windows policy.
4. Switch to another OS user or log out. Verify existing workers stop and the
   original user's daemon cannot attach to the new user's console desktop.
5. Stop/remove the service during active control, then reinstall it. Check that
   held controls release, stopped-service errors are visible, and a fresh
   connection succeeds after restart. Test an app update and an uninstall with
   both accepted and cancelled administrator approval.

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
pending dialog does not block other daemon work. The user grants access locally
and selects monitors when the desktop provides a picker. `deskfleet-wayland` owns one shared portal session on
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

Welcome and Settings → Permissions explain that each wanted monitor must be
selected when the system dialog provides a picker. GNOME can offer monitor
selection, while KDE's combined remote-desktop flow can authorize all outputs
without a separate picker. Their Wayland screen-sharing action remains available
after access is granted so the user can authorize screen sharing again. This
explicit local action closes the current screen/input session, discards its
saved restore token, and opens fresh combined consent with multiple monitor
selection enabled. Existing viewers and controllers lose the old source IDs;
the permission watch stays active and publishes the replacement grant. Cancelling
does not restore the old selection. Startup restoration, permission refresh,
and input-only retries do not reselect screens.

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
desktop becomes idle. GStreamer tries VA-API and NVENC hardware encoders when
available. H.264 can fall back to the optional CPU-based `x264enc` plugin. Linux
probes H.264, H.265, and AV1 independently, requiring a registered encoder and
parser for each advertised codec.
The viewer uses the existing AV1 → HEVC → H.264 preference among the codecs both
ends support. An encoder failure retains the existing fallback to a new peer
with the next common codec.

This path uses CPU copies, not DMA-BUF zero-copy. Encoder candidates are checked
with the first real frame. H.264 constrained baseline and H.265 Main produce
Annex B access units with parameter sets on keyframes; AV1 Main produces OBU
temporal units. Codec-specific settings disable frame reordering/lookahead so
an idle desktop can emit a frame immediately. x264 uses its `ultrafast` preset
with `zerolatency` tuning on two slice threads. It cannot encode odd 4:2:0
sizes, so its input drops a trailing odd pixel column and row. Requested
keyframes use the latest retained frame. Portal closure invalidates capture and
input; every bounded capture poll checks the source generation so retained
frames cannot outlive authorization.

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
the same GStreamer encoder and WebRTC pipeline as Wayland. X11 capture
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
system audio. Desktop streaming still requires one of the GStreamer encoders above.

### Android Termux (`scrcpy-server`)

On Linux (such as `linux-arm64` inside Termux `proot-distro`), setting
`DESKFLEET_ANDROID_SCRCPY_SERVER` to an upstream `scrcpy-server` v2.4+/v3.x JAR
routes display/codec discovery, hardware video streaming, and touch/key input
through `com.genymobile.scrcpy.Server` in UID 2000 instead of Wayland or X11
(`linuxDesktopBackend` stays `null`). Transport defaults to `adb`
(`DESKFLEET_ANDROID_SERIAL` or `ANDROID_SERIAL`), or uses
`DESKFLEET_ANDROID_SHELL` (e.g. `rish -c` or `su -c`) over an abstract Unix
socket; `DESKFLEET_ANDROID_SCRCPY_VERSION` overrides the server version string.

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

The native desktop stream pool owns capture and encoding on one blocking
worker per matching stream profile, preserving D3D11 thread ownership and retained
GPU surface lifetimes. A profile includes the display, negotiated codec, audio,
frame rate, bitrate limits, and resolution bounds. Each authenticated Machine
registration owns a pool; different backends or Teams never share it. Sessions
in the same registration can reuse a display stream because desktop capture
belongs to the Machine, not to an AgentSession.

Raw frames stay in Rust. Encoded packet buffers are shared across subscribers,
with bounded delivery and an independent async sender for each peer. A slow or
failed sender cannot block the other viewers. New viewers and silent viewers that
fall behind request a keyframe and wait for it before sending video. A lagging
audio-enabled viewer ends its own stream, since skipping packets would break
its audio/video timing. Each peer retains its own WebRTC transport, grant, input
authorization, and shutdown. `stopDesktop()`
and `close()` detach that subscriber; the last subscriber releases capture and
encoding. Capture failures reach every attached peer with their original encoder
fallback classification. `startDesktop()` waits for that subscriber's first
nonempty keyframe. The worker polls asynchronous encoder output even when the
desktop has not changed. Dropping a stream also releases its subscription.

Desktop options select a display, frame rate, bitrate ceiling, and optional
hard peak bitrate. The bitrate fields are an upper bound for congestion-driven
adaptation (default ceiling 8 Mbps when omitted), not a fixed open-loop CBR
target for the whole session. Frame rate is capped at the display's refresh rate
when known. Optional `maxWidth` and `maxHeight` bounds must be supplied together.
The native pipeline preserves the display's aspect ratio, rounds down to even
encoder dimensions, and never upscales. Windows resizes BGRA surfaces on the GPU
before encoding, macOS requests smaller ScreenCaptureKit surfaces, and Linux
downsamples the captured BGRA buffer. Capture acquisition is paced at the
selected frame rate; keyframe requests coalesce until the next video tick. The
UI does not expose encoding parameter knobs; codec choice remains automatic by
mutual support.

### Congestion-driven bitrate

Sending desktop peers install GCC/TWCC and a desktop pacer before the default
NACK/report/TWCC-receiver interceptors. GCC starts at 8 Mb/s; the encoder starts
at the same rate, clamped to the stream's configured ceiling (including the
150 kb/s preview ceiling). The pacer starts at, and follows, 2.5 times the GCC
estimate to accommodate IDR bursts and RTP overhead. This is a burst release
budget, not a promise of network capacity; feedback still lowers the estimate.

A `ReportingEstimator` publishes each peer's GCC target on a watch channel.
Shared streams use the lowest active subscriber estimate; disconnecting a viewer
removes its estimate. Keyframe requests from all subscribers are coalesced by the
shared worker. The worker clamps the estimate into `[100 kb/s, configured ceiling]`
and retargets only when both 10% and 50 kb/s hysteresis thresholds are met. This avoids frequent Linux
VA encoder reconfiguration, which drains references and restarts its GOP.
VideoToolbox, GStreamer and Media Foundation retarget live. Windows NVENC checks
dynamic-bitrate capability and uses `NvEncReconfigureEncoder` without resetting
the session or forcing an IDR. A device that does not support or rejects a live
bitrate update (including a failed capability query) recreates once at the requested rate, rather than
jumping to the ceiling. Driver status is logged before this fallback; encode
and initialization failures remain fatal. Linux NVIDIA properties use
1024-bit kilobits; VA properties use 1000-bit kilobits.

Each media-track write completes when its final RTP packet leaves the pacer,
so the pacer holds at most one original sample per track. A large IDR cannot be
truncated by the upstream default 4096-packet limit. The shared capture-to-delivery
broadcast holds eight packets. When every subscriber's pacer backlog exceeds
150 ms by age or expected send time, the worker pauses raw video submission while
draining encoder/audio output. One slow subscriber cannot pause capture for a
healthy viewer. Keyframe requests remain pending through that pause, and the next
capture uses current desktop pixels. ScreenCaptureKit callbacks replace a single
raw-frame slot, matching the latest-frame behavior of the Linux capture paths.
A silent subscriber that overruns the broadcast discards its pending dependent
frames and resumes at a new keyframe; an audio-enabled subscriber ends its stream
to preserve audio/video timing. Retransmissions cannot enlarge an already
congested pacing queue.
RTCP bypasses pacing, and TWCC/send history still record actual release times.
Capture timestamp gaps are preserved in RTP across skipped raw frames.
Sends taking at least 150 ms emit a debug diagnostic with media kind, encoded
byte count and elapsed send time; no captured content is logged.

The 150 ms threshold controls admission, not a hard end-to-end latency guarantee:
an already encoded IDR still needs to cross the available network. Framerate
and resolution ladders remain outside this control loop.

The Session's right-hand Desktops tab requests one silent, read-only stream per display
with `fps: 1`, `bitrateBps: 150_000`, `maxWidth: 320`, and `maxHeight: 180`.
Multiple viewers using the same negotiated codec reuse this preview's capture
and encoder. A full-resolution viewer or a different codec uses a separate profile.
Preview peers negotiate H.264 only, because HEVC and AV1 receive support varies
across clients and platforms and a thumbnail must decode everywhere it is shown.
The full viewer keeps the AV1 → HEVC → H.264 preference.
It initially shows the Session's owning machine. Users can switch to all
remote machines in the current Team; narrowing the scope closes the other peers.
Offline machines, unavailable capture, and individual connection failures remain
visible in the panel. Pausing, selecting another tab, or hiding the page closes
its preview peers; returning resumes them. Leaving the Session disposes its
machine adapters. Changing Sessions restores the Session-machine scope. Selecting
a preview opens that display in the normal viewer without preview limits, with
mouse/keyboard control and supported system audio enabled by default.
Display, system audio, and control settings remain editable while connecting or
streaming. Embedded browser viewers negotiate supported audio and a settings/input channel
when connecting. Audio and control changes use that existing channel without
replacing the peer or interrupting video. Capture startup snapshots the latest
audio and control settings after negotiation; initial audio delivery is set
before capture starts, including when the negotiated audio track starts muted.
Audio off mutes local playback and
stops audio delivery to that peer; the negotiated track and shared capture remain
available for immediate resumption. Disabling control stops the input worker and
releases held input; enabling it creates a worker for the current display after
checking the peer's control grant.
Changing displays automatically closes the previous peer and negotiates a
replacement, waiting for cleanup to release input ownership. An incompatible
display reports a settings error while keeping the current stream; selecting a
compatible display can still switch automatically. That selection error remains
visible until a valid selection or disconnect; replies and codec fallback for
the current stream cannot dismiss it. Disconnecting or
leaving the viewer cancels pending changes. Fullscreen and an intentional control
pause survive display changes; explicitly changing control clears that pause.

## Daemon integration

`startDaemon()` returns `peers: PeerSessions`. The CLI also starts an authenticated
local control socket (Unix-domain socket or Windows named pipe). Its private
`<daemon directory>/daemon.json` discovery record contains the endpoint and a
random per-run token. Standalone daemons default to `~/.deskfleet`, with
`DESKFLEET_DAEMON_DIRECTORY` as an override. Electron uses `<userData>/daemon`
and ignores that override. It can reuse a standalone daemon only when that daemon
is explicitly configured to use the same directory. A live daemon prevents a
second process from replacing its record.
The health endpoint remains read-only and does not expose signaling or capture.

The local contract in `apps/daemon/src/control-protocol.ts` carries authentication,
capability discovery, SDP offers/answers, trickle ICE, capture start, close, and
session events. The daemon assigns native peer IDs internally; each socket can
operate only on its own sessions. Disconnect releases those peers and capture
workers. Agent sessions and the daemon remain running. Daemon shutdown closes
all peers, including pending creation.

## Browser playback

After login and machine enrollment, select the target machine in the Web or
Electron client and open **Remote control → Desktop**. Refresh capabilities if needed,
choose a display, then connect. The viewer selects AV1, then HEVC, then H.264
from the codecs that display and the browser share, and shows the choice as
status text. On macOS, the daemon process
needs Screen Recording permission; supported system audio is enabled by default
and can be switched off or on while connected.
Windows supports NVENC video and the hardware Media Foundation fallback described above.
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
preload bridge. This embedded playback path remains available alongside the
native window.

Disconnect, switching away from the Desktop tab, navigation away from the desktop
view, renderer reload/crash, and client exit release the corresponding media
session. Tab switches retain display and stream settings; returning to Desktop
does not reconnect automatically. A browser page or installed PWA that resumes
from suspension retries a connection or setup timeout automatically, while
capture and permission failures keep their manual Connect action. Hiding the
desktop view or ending its stream also exits its fullscreen stage; an
unsuccessful exit keeps the manual exit
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

## Native desktop window

The Linux, Windows, and macOS Electron clients offer **Open in native window**
when the `native_presentor` Statsig gate passes and the display advertises a
supported video codec.
The gate defaults off and remains in place for testing across several future
versions; see [analytics rollout](analytics.md#feature-gates-and-experiments).
Closing the gate blocks new launches while existing native windows retain their
normal session lifecycle. Team authorization remains independent of the gate.
It opens `deskfleet-viewer`, a Rust executable whose thin entry
point calls the reusable `deskfleet-desktop-viewer` library. The desktop UI uses
a GPUI Fast window with a pure-Rust NSH floating toolbar.
The viewer owns its window, receive-only WebRTC peer, decoder, and GPU
presentation. The current native receive path supports AV1 Main, HEVC Main,
H.264 constrained baseline,
and optional mouse/keyboard control;
it does not negotiate system audio. The embedded browser viewer remains available.

The toolbar follows the embedded desktop viewer's layout, color tokens, and
English, Chinese, and Japanese translations. Electron supplies the selected
locale and theme when opening the window. The toolbar shows connection and
codec status, can be dragged within the window, enters or leaves full screen,
pauses or resumes remote input, and disconnects. Settings select a display and
enable or disable remote control. Display changes replace the receiving peer
while keeping the window open; an incompatible display leaves the current
stream running and shows a settings error. Control-setting changes configure
the current peer, while pause only gates local input.
The Ctrl+Alt+Del action appears when the target Windows machine advertises
secure-attention support. A view-only session keeps input disabled until control
is enabled through an acknowledged, authorized settings change. System audio
remains unavailable in the native receive contract. Toolbar interactions are
handled locally before remote input; entering the controls, pausing control,
losing window focus, or closing the
window releases remote keys and mouse buttons. Video coordinates exclude
letterboxing and use the window's logical coordinate space. NSH exchanges only
control state and actions with the host: decoded frames stay in Rust and never
cross the NSH engine as UI props or JavaScript data. This UI does not enable
NSH's JavaScript, WebView, or built-in video runtimes.
On Linux compositors requiring client-side decorations, the host provides a
local title bar and resize borders; these regions are excluded from remote
video input. On every platform, points outside the GPUI client content remain
local: native title bars and resize borders are never forwarded as remote input
or consumed by the viewer, so the platform keeps handling dragging, resizing,
and window controls.

Per-window Wayland, X11, macOS, and Windows hooks capture native physical key
codes before layout or IME translation. These map to the existing physical
`KeyboardEvent.code` contract, preserving supported key locations, modifier
sides, and keypad distinctions. Disabling remote input clears pending presses;
resuming restores held modifiers without replaying keys typed into local UI.
The hooks require runtime acceptance on each platform, including non-US layouts
and focus transitions. GPUI's layout-derived key events are used for local UI
navigation, not remote key mapping.

The floating toolbar uses its content's intrinsic width, capped to the viewport,
independently of its docked or dragged position. Positioning an auto-width
toolbar with the previous measurement's left inset limited its next layout to
that width, making newly available controls unfold across many frames. The
toolbar now reaches its full width immediately while retaining layout coordinates
for tooltip anchors.

NSH/GPUI is the sole desktop window implementation. Android continues using
its existing native surface implementation.

Electron's main process owns Team authorization, capability discovery, peer
grants, signaling, and remote capture startup. It exchanges only control,
SDP/ICE, and status messages with the child through private stdin/stdout pipes.
The viewer never receives the account credential and pixels never pass through
JavaScript. It uses the grant's STUN/TURN configuration and the existing
`desktop:stream`/`desktop:control` authorization and input DataChannel contracts.
Grant expiry or revocation, account changes, viewer closure, and application
exit close the corresponding peer and capture stream. Disconnect and recoverable
session errors leave the native window open with connection controls. A `stop`
command and `stopped` acknowledgement separate peer teardown from process
closure; replacement waits for both the old native peer and its remote grant
to be released. Navigating away from the
Desktop tab leaves the separate native window running. Closing a native viewer
does not stop the hosted daemon or another session.

Remote release waits for input, capture, and transport cleanup. A previously
reported media failure does not make a completed capture teardown fail again;
startup still returns its original media failure and codec classification.
Actual teardown failures for an established stream still reject `peer.close`.
Revocation and reconciliation cleanup errors are logged without disconnecting
the daemon's authenticated control channel, so other requests and cleanup
receipts can still complete.

Once ICE is connected, a failed outgoing trickle-candidate request is logged
without closing the established viewer; remaining candidates still get sent.
Before connection, the same failure ends startup and releases the grant.
Revocation, expiry, account changes, and transport failures retain their normal
cleanup behavior.

Before making an offer, the viewer reports its installed platform decoders.
Electron intersects these with the selected display's encoder capabilities,
preferring AV1, HEVC, then H.264. The selected codec and display dimensions cross
the control pipe explicitly and the same codec is used in the daemon offer.
Startup also waits for the first successfully decoded frame. Only an encoder
or decoder startup failure tries the next common codec, using a new peer and
grant inside the same native process after the previous peers have closed.
Authorization, signaling, input, and transport failures do not trigger codec
fallback. Unavailable codec extensions or hardware never imply support.
While the capture-start RPC is pending, a peer closure, expired local or remote
disconnect grace, or resulting native transport error waits for that RPC's result:
encoder startup may close the peer before returning its classified failure.
A successful RPC still surfaces any
pending transport failure. Revocation, expiry, and explicit window closure
remain immediate, and the existing startup deadline bounds the wait.
The native window emits `closeRequested` before shutting down its transport.
Electron treats this user action as immediate cancellation even after a deferred
transport failure; the final process `closed` notification remains separate.

Capture startup waits for both the native peer's connection and its explicit
acknowledgement that the SDP answer was applied. Local ICE candidates wait for
the signaling answer; remote candidates remain ordered behind that answer on
the viewer pipe. Control input is sent only after the remote `deskfleet-input`
channel returns `ready`; an error or channel closure ends the session. Opening
a control window waits for capture startup, the first decoded frame, and this readiness acknowledgement,
with a 10-second input readiness deadline after capture starts. View-only windows
do not create or wait for an input channel. A transient `disconnected` state on
either peer has the shared 10-second recovery grace; recovery keeps the same
capture, while sustained loss releases the peer and grant and leaves the native
window available to reconnect.

The window-to-session input queue holds at most 256 events and coalesces only
adjacent pointer moves, preserving key/button/wheel ordering. On overflow, it
discards pending input and the overflowing action, then queues `ReleaseAll`
without closing the video. Focus-loss release also clears pending presses.
Any event already being sent precedes the reset on the ordered DataChannel;
fresh input follows it. Actual transport send failures still close the peer.

The receive task and blocking decode worker run independently of the window.
`deskfleet-linux-media::RtpVideoDecoder` loads GStreamer on demand and feeds full
RTP packets through `rtpjitterbuffer`, the matching H.264/HEVC/AV1 depayloader
and parser, and a hardware decoder. AV1 requires the `rsrtp` plugin's
`rtpav1depay`; parsed output is constrained to complete temporal units.
H.264 and HEVC constrain depayloader output to complete access units before the
parser so loss recovery retains in-band SPS/PPS or VPS/SPS/PPS with the keyframe.
AV1 retains OBU-aligned depayloader output until `av1parse` assembles temporal
units; its depayloader preserves the sequence header at the RTP new-sequence bit.
The RTP reorder budget is 10 ms; appsrc accepts at most 256 queued
packets and 1 MiB, returning backpressure to its caller instead of silently
discarding compressed input. The depayloader waits for a keyframe after loss and
its upstream refresh events become WebRTC PLI requests. The decoded appsink has
one FIFO position and `sync=false`; it does not wait for a PTS playback clock.
VA-API and NVDEC factories are tried when installed. Hardware setup or stream
errors remain visible rather than silently selecting a software decoder.

On Windows, the viewer uses synchronous system Media Foundation decoders with a
D3D11 device manager and low-latency mode. HEVC and AV1 are discovered through
`MFTEnumEx` and require their installed Windows codec extensions.
HEVC samples carry explicit NAL length metadata so an idle final picture does
not wait for a following sample. `rtp_video.rs` owns a bounded 64-packet,
10 ms RTP reorder window and Annex B access-unit assembly for single NAL,
STAP-A, and FU-A packets. Duplicate/late packets are ignored; loss or malformed
fragmentation discards the incomplete picture, requests PLI, and waits for an
IDR with cached SPS/PPS. Complete pictures are bounded to 8 MiB. A full reorder
window or pending compressed access unit backpressures the receive worker.
HEVC supports single NAL, aggregation, and fragmentation units without DONL;
recovery waits for an IRAP with cached VPS/SPS/PPS. AV1 reassembles sized OBUs
using the transport's AV1 depacketizer, rejects orphaned fragments, and waits
for a new coded sequence after loss. Fragmented OBUs share the picture bound.
Media Foundation output is polled while idle, without EOS flushing or a PTS
playback scheduler. Output type changes renegotiate NV12; owned RGBA pixels
honor the output color matrix and nominal range. Hardware mode requires DXGI
output surfaces and fails visibly if acceleration cannot start. The explicit
`DESKFLEET_VIEWER_DECODER=software` diagnostic uses the same system decoder
without a D3D11 manager. Windows requires the Media Foundation components
(including the Media Feature Pack on Windows N editions), not GStreamer.

On macOS, VideoToolbox decodes the same bounded RTP assembly into BGRA
pixel buffers, copied row by row into owned RGBA. The default decoder requires
hardware acceleration; `DESKFLEET_VIEWER_DECODER=software` explicitly disables
hardware decoding for diagnostics. No additional media runtime is installed.
Capability discovery uses `VTIsHardwareDecodeSupported`. HEVC format descriptions
use VPS/SPS/PPS; AV1's dimensions and `av1C` record are parsed from the sequence
header, accepting the negotiated 8-bit Main-profile 4:2:0 stream.
The decode worker submits each access unit synchronously, with asynchronous and
temporal processing disabled, so output does not wait for a later picture or
EOS. Parameter-set changes recreate the decompression session. Session
invalidation precedes releasing callback state.
The synchronous callback lifetime follows Apple's
[VideoToolbox decoding contract](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsessiondecodeframe%28_%3Asamplebuffer%3Aflags%3Aframerefcon%3Ainfoflagsout%3A%29).

Decoded images are copied into owned RGBA pixels. The NSH/GPUI viewer converts
that owned buffer to BGRA and submits it through GPUI's GPU image path, which
composites the video and toolbar in one window. Superseded image cache entries
are released after rendering. This path has GPU readback and upload; it is not
a shared-surface or zero-copy decoder integration. The decoder's reference
surface pool is
independent of the presentation queue.

### Decoded-frame queue and presentation

The application retains at most two decoded, uncommitted candidates. A newly
decoded picture evicts the oldest candidate only when both positions are full.
The window takes the oldest retained candidate when it can submit a new image.
Later arrivals cannot replace an image already selected for that submission.
An empty queue leaves the existing image on screen; startup never waits to fill
the queue. There is no PTS playback scheduler, predictive vsync timer, or
three-frame prefill.

The NSH/GPUI viewer selects at most one candidate for a GPUI render, and requests
another frame while candidates remain. GPUI owns the swapchain and frame
scheduling. Its `presentationMode` is `gpui`; `submittedFrames` counts images
submitted to the GPUI scene, and `presentedCommits` is absent/null. This mode does
not expose compositor presentation feedback or an explicit
one-outstanding-Wayland-commit gate. The retained two-candidate bound
does not establish the depth of GPUI's or the compositor's presentation queues.
Latency, frame pacing, and resource use still require measurements
on each supported desktop platform.

Status distinguishes decoded, submitted, and candidate-drop counts.
The ready-to-submit measurement starts after decoding and excludes transport,
decoder delay, and scanout. These measurements do not establish end-to-end
latency by themselves.

### Build and validation

`mise run desktop:dev` builds the native viewer alongside the native addon.
Linux, Windows, and macOS packaging stage the release viewer executable outside ASAR
(`native/deskfleet-viewer.exe` on Windows). On macOS it lives at
`Contents/Resources/native/deskfleet-viewer` and is included in application
signing. The Linux client also
needs the GStreamer app, RTP, matching codec parser, video conversion, and hardware decoder
plugins on the receiving machine.
Linux builds of the NSH/GPUI backend additionally need the development libraries
for Fontconfig, FreeType, XKB/XKB-X11, XCB, and Wayland. Runtime GPU rendering
requires a working graphics driver and the corresponding platform libraries.
The NSH 0.4.0 backend and GPUI Fast 0.1.9 are pinned together to the versions in
NSH's released GPUI workspace lockfile.

On Windows, the viewer executable uses the GUI subsystem and its launcher does
not set `windowsHide`: that flag also hides GPUI's window, even while the peer
connects and decodes video. The launcher sets `GPUI_VIEW_RETENTION=0` only in the
Windows viewer child's environment. GPUI Fast 0.1.9's retained accessibility
replay loses NSH's synthetic subtree hierarchy and can panic with duplicate
children after a UI Automation client activates accessibility. This workaround
keeps accessibility enabled while rebuilding views instead of replaying that
cache; remove it after validating a dependency fix with nested NSH controls and
an attached UI Automation client. The smoke test uses the same launch function
as Electron so these process options are covered by runtime checks.

```sh
mise run viewer:build
mise run desktop:smoke-native-viewer
DESKFLEET_SMOKE_CODEC=h265 mise run desktop:smoke-native-viewer
DESKFLEET_SMOKE_CODEC=av1 mise run desktop:smoke-native-viewer
DESKFLEET_SMOKE_HARDWARE=1 DESKFLEET_SMOKE_FPS=60 mise run desktop:smoke-native-viewer
mise exec -- cargo test -p deskfleet-linux-media --locked decoder::tests -- --ignored --nocapture
```

The smoke command opens a real native window and negotiates fixture video
with another Rust peer. It checks answer application, the real ordered input
channel's readiness handshake, decode, and image submission, without desktop
capture or OS input injection. On Linux, `DESKFLEET_VIEWER_DECODER=software` explicitly selects
GStreamer's `avdec_h264` for diagnostics; this requires the libav plugin and is
never an automatic fallback. Runtime decoder tests separately exercise hardware
encoding/decoding, delivery of an initial IDR and a final dependent P picture
without another picture or EOS, and packet-loss recovery through PLI.

Historical Linux Wayland validation of the initial NSH/GPUI toolbar passed all
28 viewer Rust tests and Clippy. A 120-second H.264 fixture run with the explicit software
decoder passed input readiness, image submission, and clean shutdown while
retaining at most two candidates. This validates the GPUI submission path, not
compositor display completion or comparative end-to-end latency.

Interactive fixture checks covered toolbar dragging, including an 80 ms drag,
pausing control, entering and leaving full screen, double-clicking the title
bar to maximize, and disconnecting cleanly. A separate startup check verified
title-bar dragging, resizing from 960×640 to 800×480 with the toolbar remaining
inside the window, and user closure before a `start` command. The receiving peer
observed a video
center click at normalized `(0.5, 0.5)` and Ctrl+A. Toolbar gestures produced
only `releaseAll` resets; video clicks and KeyB while control was paused were
not forwarded. `DESKFLEET_SMOKE_REPORT_INPUT=1` makes the fixture peer emit
`{"kind":"input","event":...}` diagnostics for these checks without injecting
input into the operating system. These checks predate the full toolbar,
persistent peer replacement, and physical-key hooks; they do not establish
runtime acceptance of those changes.

The replacement-window follow-up passed 27 viewer tests, 20 input tests, and
strict Clippy on Linux. Focused native session/IPC tests and Electron type
checking also passed. A live Wayland H.264 fixture exercised display selection,
stop/start across three peers in one window, disconnect/reconnect, live control
configuration without a peer restart, and clean process shutdown. Physical
Ctrl+A reached the fixture as `ControlLeft`/`KeyA`; pause suppressed KeyB and
resume restored KeyC. The full floating toolbar and display selector were
visually inspected; an 80 ms drag and keyboard nudging retained its bounded
position. The final build also preserved the settings panel across control
changes and rendered Chinese translations, light colors, settings errors, and
full-screen controls. These checks used explicit software decoding and
synthetic pixels, and do not
establish macOS/Windows runtime acceptance or latency parity.

The recorded Windows and macOS results below are historical results from the
removed winit/wgpu presenter; they do not validate the NSH/GPUI UI. Its acceptance
on those platforms also requires toolbar dragging, window resizing, full-screen
transitions, local input interception, focus-loss release, and user closure
during startup. Focus-loss release is unit-tested but has not yet been checked
with a held key during a real desktop session.

Windows validation on the implementation host passed the fixture WebRTC →
D3D11 decode → wgpu submission smoke with clean shutdown and at most two
decoded candidates. The opt-in runtime test below also verifies red RGBA output
and delivery of a single idle IDR without another input picture or EOS. The
same test and window smoke pass with the explicit software diagnostic. Actual
Windows display completion, final dependent-P delivery while idle, real remote
desktop/input acceptance, and packaged installation remain unverified.

```sh
mise exec -- cargo test -p deskfleet-desktop-viewer --lib --locked windows_decoder::tests -- --include-ignored
```

The decoder setup follows Microsoft's [H.264 decoder contract](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder)
and [low-latency property type requirement](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avlowlatencymode).

macOS runtime tests exercise an idle fixture IDR, a synthetic VideoToolbox
IDR/dependent-P sequence, RTP timestamp wrap, and a resolution change. Each
picture must arrive before the next input picture or EOS; decoded pixels are
checked for red RGBA output. These tests use synthetic pixels and require no
Screen Recording or Accessibility permission.

```sh
mise exec -- cargo test -p deskfleet-desktop-viewer --lib --locked macos_decoder::tests -- --include-ignored
DESKFLEET_VIEWER_DECODER=software mise exec -- cargo test -p deskfleet-desktop-viewer --lib --locked macos_decoder::tests -- --include-ignored
mise run desktop:smoke-native-viewer
```

`DESKFLEET_SMOKE_VIEWER` can select the executable inside a packaged app instead
of `target/debug/deskfleet-viewer`, allowing the same WebRTC/decode/window/cleanup
smoke to validate the packaged binary.

On the macOS ARM64 implementation host, all 14 viewer tests passed, including
both opt-in hardware runtime tests. Both runtime tests also passed with the
explicit software decoder. The fixture WebRTC → VideoToolbox → Metal window
smoke passed in both modes with clean shutdown and at most two candidates.
Release staging and a local unpacked `.app` build also passed; the executable at
`Contents/Resources/native/deskfleet-viewer` passed the same hardware smoke.
That local build reused the existing native addon and disabled Developer ID
signing and notarization. Formal signed installation and real remote input
acceptance remain unverified.
That removed presenter reported `fifo-hint`; these runs did not measure actual
display completion or comparative end-to-end latency.

`DESKFLEET_SMOKE_HARDWARE=1` selects generated 320×240 pixels encoded by the host's
video encoder, including the optional x264 fallback on Linux. In that mode,
`DESKFLEET_SMOKE_FPS` accepts a finite rate from 1 through 240, defaulting to 10.
Capture deadlines follow an elapsed monotonic clock so encoder
work does not add to every frame interval; missed slots are skipped after a
stall. The pre-encoded 64×64 fixture keeps its fixed 10 fps rate.

GStreamer 1.26's VA H.264 decoder retains the final picture of the existing
all-IDR `red-64x64.h264` fixture, whose SPS specifies a one-picture DPB, until
another picture arrives. The fixture diagnostic reports this delay without
flushing it away with EOS. The tested production VA encoder instead supplies a
four-picture DPB with zero reorder frames; both its first IDR and final P picture
are delivered while the source is idle. The software diagnostic decoder also
delivers the single fixture picture immediately. This decoder behavior is
separate from the decoded-frame queue and GPUI presentation.

## Mouse and keyboard control

**Mouse and keyboard control** is enabled by default for the selected display.
Click the video to focus keyboard input; the surrounding application keeps its
normal keyboard behavior when the video is not focused. The toolbar can
pause/resume input without stopping the video. In both the embedded browser
viewer and the native window, changing control while connected updates the
current peer; disabling it releases held input.
The daemon acknowledges each settings request on the ordered input channel and
checks stream and control authorization separately. A rejected settings change
reports an error without closing the video connection. Native settings requests
are serialized on the same channel, and input stays gated by the acknowledged
remote control state.

The viewer sends JSON events on the reliable, ordered `deskfleet-input`
DataChannel. `pointerMove` and `pointerButton` use normalized display coordinates
in [0, 1]; the viewer removes the video's letterboxing before mapping pointer
positions. Buttons follow DOM numbering (left, middle, right, back, forward).
`wheel` carries CSS pixel deltas (positive right/down), and `key` carries physical
`KeyboardEvent.code`, pressed state, and repeat. The remote keyboard layout
determines characters. Physical keys that the target cannot map are ignored without
releasing held input or disconnecting the stream. Malformed messages and OS injection
failures still fail the connection. Clipboard, text/IME composition forwarding, and operating
system shortcuts intercepted by the viewer's OS are outside this contract, apart
from the explicit Windows `secureAttention` action described above.
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
Screen Recording permission is separate. Without the optional desktop service,
Windows injection follows SendInput's integrity restrictions: it cannot control
elevated applications from a lower integrity process or operate the secure
desktop. Service workers inject within their authorized console session at
SYSTEM integrity. Wayland input uses the
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
available encoder and its codec parser. Wayland capture additionally requires
`pipewiresrc`; X11 capture uses the X protocol directly:

| Codec | VA-API factories | NVENC factories | Parser |
| --- | --- | --- | --- |
| H.264 | `vah264enc`, `vah264lpenc` | `nvh264enc`, `nvautogpuh264enc` | `h264parse` |
| H.265 | `vah265enc`, `vah265lpenc` | `nvh265enc`, `nvautogpuh265enc` | `h265parse` |
| AV1 | `vaav1enc`, `vaav1lpenc` | `nvav1enc`, `nvautogpuav1enc` | `av1parse` |

Hardware factory availability depends on the installed GPU and driver; one codec's
missing plugin does not disable other codecs. The H.264 software fallback needs
[`x264enc`](https://gstreamer.freedesktop.org/documentation/x264/index.html),
typically in `gstreamer1.0-plugins-ugly` on Debian and Ubuntu. It also needs
`h264parse`, typically in `gstreamer1.0-plugins-bad`. The [VA-API](https://gstreamer.freedesktop.org/documentation/va/index.html)
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

On an NVIDIA-backed Windows display that supports all three codecs, also run:

```powershell
mise exec -- cargo test -p deskfleet-encoder --locked windows_nvenc_emits_each_frame_without_lookahead -- --ignored --nocapture
```

This directly exercises NVENC H.264 Baseline/Main/High, HEVC Main, and AV1.
Each submitted frame must return one packet immediately, including an explicitly
requested keyframe on an unchanged desktop. The test also checks submitted
timestamps are preserved and EOS completes successfully. It checks output
behavior, not decoded quality or end-to-end WebRTC latency.

On a Linux graphical host with the runtime and GPU drivers installed, run:

```sh
mise exec -- cargo test -p deskfleet-linux-media --locked -- --ignored --nocapture
```

These tests copy a generated GStreamer frame, retain the last update of a burst
across paced reads, and check capture timeouts and stop handling. They also encode
a generated frame and an idle keyframe with the hardware encoders of every
advertised codec, and with `x264enc`. Both keyframes must decode in fresh decoder
pipelines, with increasing timestamps and correct dimensions/pixels.
No desktop authorization is requested.

The x264 tests need `x264enc` and never select a hardware encoder. On a host
without GPU encoding, run them alone:

```sh
mise exec -- cargo test -p deskfleet-linux-media --locked x264_ -- --ignored --nocapture
```

To send generated video through WebRTC to Chromium, run each
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

Windows capture smoke also opens/releases the input controller twice. After
enabling **Remote control while locked**, require the service explicitly so an
absent installation cannot pass by using the user-process backend:

```powershell
$env:DESKFLEET_SMOKE_CAPTURE = "1"
$env:DESKFLEET_SMOKE_WINDOWS_SERVICE = "1"
mise run desktop:smoke-media
Remove-Item Env:DESKFLEET_SMOKE_WINDOWS_SERVICE
Remove-Item Env:DESKFLEET_SMOKE_CAPTURE
```

This checks the current desktop's service-backed capture, encode, WebRTC decode,
and input attach/detach. It does not lock the host, inject credentials, or exercise
UAC, user switching, software SAS policy, or app installation/update recovery;
those remain the interactive acceptance steps above.

Set `DESKFLEET_SMOKE_CAPTURE_SECONDS=60` (an integer from 1 to 300) to keep the
same capture peer open for that many seconds after its first decoded frame.
The smoke prints timestamped frame/keyframe counters, dimensions, and connection
state once per second without recording pixels. Lock and unlock the host during
this observation, then compare counters around each transition; an overall smoke
pass alone does not establish that every transition produced a fresh frame.
Run a separate service-required smoke while the host is already locked to check
fresh display discovery, capture startup, and input-controller attach/detach.
Remove `Env:DESKFLEET_SMOKE_CAPTURE_SECONDS` afterward to restore the quick check.

To verify preview scaling and frame pacing against a real desktop on Windows:

```powershell
$env:DESKFLEET_SMOKE_CAPTURE = "1"
$env:DESKFLEET_SMOKE_PREVIEW = "1"
$env:DESKFLEET_SMOKE_CAPTURE_SECONDS = "5"
mise run desktop:smoke-media
Remove-Item Env:DESKFLEET_SMOKE_CAPTURE
Remove-Item Env:DESKFLEET_SMOKE_PREVIEW
Remove-Item Env:DESKFLEET_SMOKE_CAPTURE_SECONDS
```

This checks decoded dimensions within 320 x 180 and at most one new frame per
second over the observation period, allowing one in-flight frame. The desktop
pixels are not saved. An unchanged desktop can produce fewer frames.
