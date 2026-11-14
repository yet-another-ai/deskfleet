# Files, transfers, and Agent resources

The machine file service supplies the two-pane file transfer panel and files
referenced by Agent Markdown. The panel lives in the machine's **Remote control**
page alongside **Terminal** and **Desktop**, including on headless machines. Both clients
use the same file contracts and transfer queue. The backend authorizes peers and
relays signaling; file contents travel directly over WebRTC, with TURN fallback.
File contents are not synchronized into central conversation history.

## Ownership and access

`FilesService` owns filesystem operations on the executing machine. Its paths
follow that machine's operating system. Listings and stat results canonicalize
ancestor aliases while preserving each entry's displayed name, so self-copy
checks compare actual locations. The selected remote target is identified
by central Team and Machine IDs; the client computer is a separate local
endpoint. The left local pane must never use the selected machine's directory
browser by accident. The local Electron endpoint works independently of the
**Run local Agent** preference and does not require local machine enrollment.

The server issues a shared `mux` grant or a legacy `files` peer grant, including
`files:read` and `files:write` actions.
The daemon checks the grant's actor, Team, target Machine, purpose, and lifetime,
then checks the required action on requests and outgoing response chunks.
Listing, stat, Session resource resolution, and reads require `files:read`;
destination creation, writes, completion, and cancellation require `files:write`.
Paths and channel labels do not grant authority. File access uses the daemon's
OS user permissions; Session association supplies path context, not a separate
filesystem sandbox.

File endpoints and their logical streams have their own lifetime. When the
client, backend, and daemon support `fixed4-v1`, they share the machine's Mux
peer with Agent and terminal streams; otherwise they retain a separate files
peer. Closing a file stream leaves sibling streams running. Switching tools,
navigating to another page, changing
the selected machine, or disconnecting a desktop stream does not cancel the
queue. A functioning peer survives signaling loss under its existing grant.
Revocation, account changes, peer closure, or the grant's maximum 24-hour lifetime
end access and close the endpoint's unfinished writes. A later request may obtain
a new peer; pending writes are not automatically replayed on it.

Electron's main process owns its transfer manager, native WebRTC peers, local
filesystem endpoint, and narrow preload API. Each renderer document has a separate
queue and receives only its own transfer events. Transfers continue when its window
is hidden and while the application stays in the tray. Full document navigation,
renderer destruction/crash, account changes, and application quit revoke its local
grants and close its queue. Hash-route changes and switching views keep it alive.
The Web client owns its manager at page/account scope,
outside the selected machine's Vue/Pinia scope. Leaving that browser page ends
its transfers. The queue is not persisted or resumed across application restarts.

The shared file panel snapshots source and destination locations, including their
nested targets, into plain objects before enqueueing. Vue reactive proxies cannot
cross Electron's context bridge or the browser transfer queue's structured clone;
the snapshots retain each location's paths and local access grant or machine IDs.

## Electron local file access

The local pane opens the OS user's home directory immediately. Desktop transfers
use the hosting process's OS file access, including Full Disk Access granted during
setup on macOS. **Choose folder** navigates to another directory; it does not grant
access or restrict subsequent browsing to that folder. Parent, home, and filesystem
root navigation remain available, subject to OS permissions.

On the first local browse or transfer request, the main process creates an opaque
filesystem grant bound to the requesting window document and current account epoch. Local
listings carry it through browsing and transfer selection; the queue retains it for
recursive reads, destination creation, and retries. Requests without an explicit
grant use that document's default grant. Forged, cross-window, and revoked grants
fail before filesystem access. These grants track access lifetime rather than
adding a separate user authorization step.

Windows drive-relative paths, device namespaces, alternate data streams, and
ambiguous trailing-dot/space names are rejected; ordinary absolute drive and UNC
paths retain their filesystem meaning.

Saving new files does not authorize replacement. Every local `replace` attempt
requires a native confirmation displaying the exact destination, including retries;
the endpoint rechecks the grant after that dialog. A folder replacement still replaces
the complete item. Revocation also prevents pending selection/confirmation dialogs
from continuing access after their document or account has ended.

Local Agent previews load automatically. Main resolves the Session's captured
first directory and its daemon-managed `<machine directory>/session-attachments/<sessionId>/`
directory through its daemon connection on the first resource request and
retains a read-only grant bound to that Session and the current window/account.
Absolute references, file URLs, and relative paths must stay within those roots; the renderer
cannot supply the captured root. The endpoint checks path containment and rejects
symlink and junction escapes for these Session grants. These path checks are not a
race-safe filesystem sandbox against another local process replacing entries
between validation and Node's path-based I/O. There is no per-Session preview button
or consent dialog. Operating-system file permissions are handled when creating the
daemon.
Downloading those resources selects a separate writable destination.
Remote file peers and explicitly authorized daemon terminal operations retain their
OS-user authority; Session roots do not globally restrict daemon filesystem access.

## Protocol and transfer behavior

The reliable ordered files stream carries length-prefixed JSON metadata followed
by raw binary file bytes. It uses the shared Mux bulk lane or the legacy
`deskfleet-files` DataChannel. File operations carry at most
127 KiB; this reserves 1 KiB for ordinary frame metadata so a full read or write
fits two wire messages instead of leaving a tiny third message. Larger metadata
still uses the same fragmentation. File wire fragments are at most 65,535 bytes
and respect a smaller negotiated transport limit. Mux divides those fragments
into frames of at most 16 KiB, including its header, with per-stream credits and
fair scheduling. These are application message sizes, not UDP packet sizes;
WebRTC owns SCTP/DTLS fragmentation. See [remote WebRTC transport](architecture.md#remote-webrtc-transport)
for shared peer ownership and capability selection.
Metadata frames have an 8 MiB limit. Each peer allows 580 pending requests,
leaving 64 slots beyond the bulk transfer window for control operations, with at
most 64 MiB of pending request payload and 8 MiB of
pending request metadata. Encoded request and response queues allow 72 MiB,
including metadata; transport sends retain their existing backpressure limits.
The RPC idle timeout is 60 seconds without send or receive progress, so a large
window can drain normally on slower links without an absolute request deadline.
The provisional protocol remains version 1.

Bulk file copies pipeline up to 516 chunks across source
reads and destination writes. Writes enter the channel in offset order without
waiting for each preceding acknowledgement, so network round trips overlap with
disk work. The slot count is derived from a fixed 64 MiB file-content budget, so
larger operations do not increase the in-flight payload limit. This is a payload
budget; protocol copies and other buffers add to process memory. Only acknowledged
bytes advance progress. File completion waits for
all outstanding operations, including when cancellation or an error stops new
work. Native and browser receivers serialize each upload's mutations; browser
abort bypasses that queue to interrupt publication and reject pending writes.

The endpoint operations are `list`, `stat`, `resolve`, `openRead`, `read`,
`closeRead`, `begin`, `mkdir`, `write`, `finish`, `commit`, and `abort`.
`begin` accepts exactly one destination target: a `directory`, a `sessionId`
targeting `<machine directory>/session-attachments/<sessionId>/`, or a UUID
`draftId` targeting `<machine directory>/session-attachments/.drafts/<draftId>/`
for pre-Session composer file attachments (adopted into `session-attachments/<sessionId>/`
on `_deskfleet/input/submit`). Composer attachment uploads reuse the same
516-chunk write pipeline with acknowledged-byte progress reporting and
`AbortSignal` cancellation (`abort`). An upload's paths are relative to its
selected root: the empty path names a root file or directory, and slash-separated
paths name descendants. Absolute paths, traversal segments, backslashes, and
alternate-stream colons are rejected in upload paths. Reads and writes check
chunk sizes and offsets; writes are sequential. Source size and modification
time detect changes while copying.

Bulk copies and resource previews open one source read session per file. The
native endpoint retains its file handle; each read validates the path's file
identity, size, and modification time before returning bytes. `closeRead`
validates once more and closes the handle, including when validation fails.
The client drains outstanding reads and writes before closing the read session;
only successful final validation allows destination finish/commit. Cancellation,
failure, and peer closure release retained handles. Each endpoint permits at most
32 active source sessions. Browser sessions retain the selected file handle and
check its size and modification time; Electron still checks path authorization
for each read. Standalone reads without a session open and release their own handle.

All native WebRTC peers request a 4 MiB UDP receive buffer when each socket is
wrapped, including after ICE rebinding. The runtime keeps larger existing buffers
and accepts OS limits without changing system-wide settings. This provides burst
headroom independently of the unchanged 1 MiB DataChannel send budget. Native
file transports pass Buffer views over owned wire frames; NAPI takes one snapshot
on the JavaScript thread before dispatching asynchronous work. Rust then transfers
owned storage into the channel and back into Node buffers where possible. Shared
storage and hosts that forbid external buffers, such as Electron, retain the
required copy instead of borrowing mutable JavaScript memory across threads.

Each selected root file or folder is one queue item. A folder's internal manifest
includes its descendants and empty directories, but the UI never expands it
into individual file rows. Preparing a folder discovers its total byte count;
the active item then displays aggregate progress and a smoothed transfer speed.
The queue processes one item at a time. Cancel stops that item and cleans its
owned unfinished staging; retry starts the selected root again.

The default conflict policy is `ask`: an existing destination stops the item for
a user choice. `skip` leaves the existing item intact. `rename` selects an unused
sibling name. `replace` explicitly replaces the complete root item, including an
existing folder and all its previous children; it is not a directory merge or
synchronization operation.

Native filesystem destinations stage the complete root beneath a private
`.deskfleet-transfer-*` directory on the destination filesystem. Every file must
finish before commit. File publication uses an exclusive hard-link operation;
this requires hard-link support on the destination filesystem. Directory
publication uses platform-specific rename/reservation behavior so
`ask` and `rename` do not silently overwrite another concurrent transfer.
Explicit replacement retains the old root in staging until publication succeeds
and restores it if publication fails. If restoration also fails, that recovery
directory is retained outside automatic cleanup and its path is reported in the
transfer error. Normal cancellation and endpoint closure
remove only staging owned by that endpoint. Cleanup never recursively deletes an
uncommitted public destination reservation.

Transfers copy regular file contents and directory structure. They do not retain
source modification times, executable bits, ownership, or extended metadata.
Native staged files are created with mode `0600`. Single file symbolic links are
read as their target's contents; links themselves are not recreated. Directory
symbolic links and special files are unsupported. Recursive transfer scans use
strict listings: an unsupported or inaccessible child fails the item instead of
silently reporting an incomplete folder as transferred. Interactive browsing may
omit unsupported or inaccessible entries.

## Mobile local folders

The Capacitor Android and iOS clients inject a native local file endpoint into
the shared page/account transfer queue. They use the same remote WebRTC endpoint
and file protocol as Web, while local disk access belongs to the Capacitor bridge.
The local pane initially lists the application's Documents directory, without
requiring a browser directory handle. **Choose folder** opens Android's Storage
Access Framework tree picker or iOS's document folder picker. Cancelling the
picker preserves the current directory.

Android requires the picker result to grant both read and write access, without
requesting broad storage permissions. A selected directory that cannot be read
is not retained as a new root or home directory. iOS uses security-scoped access
for external folders; folders already inside the app's Documents need no extra
security scope.
Each Android folder selection becomes pending before its UI-thread launch is
queued and registers its own activity-result callback. Closing its endpoint clears
the pending selection and unregisters that callback immediately. Queued launches
skip cancelled requests; late results cannot resolve or block a replacement picker.

Displayed paths are labels beneath the app's Documents root or explicitly chosen
native roots. They cannot address arbitrary device paths. Each endpoint has a
unique native session ID and owns its selected roots, open reads and temporary
uploads. Account changes and page disposal close that session, cancel its work,
remove private staging and discard its directory capabilities. iOS balances
security-scoped access; Android uses temporary, non-persisted URI grants whose
OS lifetime remains Android-owned. Selecting a folder without starting a transfer
still establishes ownership that must be released.

The Documents directory and saved files belong to the app installation and remain
available across account changes; resetting an endpoint does not erase local
files or provide per-account filesystem isolation. On iOS, Documents is exposed
through Files and file sharing. Credentials and transfer staging remain outside
Documents. The iOS bridge bundles a FileTimestamp privacy manifest declaring app-container
metadata access (`C617.1`) and metadata access for user-selected folders (`3B52.1`).

Native reads and writes pass bounded chunks through the bridge, encoded as base64
only at that boundary. Incoming files are staged in the application's cache and
must finish before publication. Android copies through native streams because
SAF providers do not expose a common atomic publication operation. An interrupted
copy can leave files already saved in the selected destination, including a
partially replaced file. Cleanup keeps these public files, removes private staging
and reports the partial copy. iOS coordinates provider access, copies into a
private sibling, then moves or replaces the destination. Its cleanup removes the
temporary sibling and preserves the public destination if publication fails.
Existing directories cannot be replaced; keep both is available. Mobile local
transfers do not use the browser's directory picker or OPFS.

Android endpoint coverage runs with the bridge's Gradle unit tests. On macOS,
`mise exec -- node packages/capacitor-bridge/ios/Tests/run.ts` tests the production
Foundation endpoint independently of the viewer XCFramework. The native folder
pickers and external document providers still require device validation.

## Browser local folders

The Web local pane uses an explicit `showDirectoryPicker({ mode: "readwrite" })`
selection and browses only retained directory handles. Displayed paths are
application labels rooted at those handles, not arbitrary OS paths. Directory
selection requires a user gesture and browser support; an unsupported browser
receives an actionable error directing the user to a supported browser or the
desktop app. The current implementation has no ZIP-download or file-input
fallback for the two-pane workflow.

Incoming data is staged in the browser's origin-private filesystem (OPFS), so
available browser storage and quota limit a transfer before it is copied into the
selected directory. The browser does not expose an atomic directory rename
between OPFS and user-selected folders. Commit copies the staged root to the
destination, and a cancelled or interrupted commit can leave files already saved
there. Those files are kept and the error explains this; cleanup removes private
staging rather than deleting a destination another application may have changed.
The browser supports explicit file replacement but rejects replacement of an
existing directory; use rename/keep-both for that case. Browser entry creation
also lacks an exclusive no-clobber primitive, unlike the native endpoint.

## Agent Markdown references

The renderer classifies filesystem references in links, image sources, and ACP
resource links, retaining the trusted executing Machine and Session context.
Absolute paths and `file:` URIs resolve on that machine. Relative paths resolve
against the Session's captured first directory, including archived Sessions whose
working context remains available. Editing Workspace directories later does not
retarget those references. Link fragments and trailing `:line[:column]` editor
locations are removed before URI decoding; encoded filename characters remain
part of the path. In a Session view, clicking any resource link opens a right-side
preview tab (or mobile preview view) first and resolves workspace authorization
and file type inside that tab: supported image, audio, video, 3D model, and modern
Office files (without line references) render in the shared previewer, directories
open in a file browser, and text or line-referenced files render as syntax-highlighted
code (falling back to a dialog when session preview tabs are unavailable). Text previews use the shared Shiki highlighter
for recognized filenames, with the same light/dark colors as Markdown code blocks.
Unknown languages, files over 200,000 characters, and highlighting failures retain
plain text. Highlighting preserves source text, line endings, and blank lines.
Text previews highlight the whole line for
`:line[:column]` and `#Lline` locations, or all lines in an ordered
`#Lstart-Lend` range, and scroll to the first requested line. Encoded location
separators remain filename characters. Invalid or unavailable line numbers do
not select another line.
HTML `.html` and `.htm` files open in the syntax-highlighted source view first
and offer a toggle into a sandboxed `<iframe src="./html-preview.html">` preview
(`sandbox="allow-scripts allow-forms"`, without `allow-same-origin`) that replaces
its location with an opaque-origin Blob document inside its own policy container,
so inline scripts run without inheriting the host renderer's `script-src` policy.
Other authorized files can be opened locally or downloaded from that tab or dialog.

Word `.docx`, Excel `.xlsx`, and PowerPoint `.pptx` previews use
`@silurus/ooxml` to parse the loaded bytes locally with bundled WASM and
render them in the client. Word pages and slides use a scrolling viewer; Excel
includes worksheet tabs. The previews are read-only. Spreadsheet formulas display
their saved cached results without recalculation, and PowerPoint animation
playback is not provided. Complex layouts and unavailable fonts can differ from
Office. Legacy `.doc`, `.xls`, and `.ppt` files use the Open or Download action.
The viewers disable Google Fonts, external hyperlink interaction, and embedded
media playback. Electron permits same-origin WASM fetches, in-memory Blob/data
previews, and bundled Blob Workers through its renderer CSP; other network origins
still require the existing explicit configuration. Parsing receives a copy of the file bytes so
Worker transfers cannot detach the bytes retained for downloading.

Codex `:codex-file-citation{path="..." purpose="output"}` markers render as
filename links through the same resource path. The quoted path is parsed before
Markdown typography and formatting can alter it; the marker cannot select a
different Team, Machine, or Session. Code examples and escaped markers stay
literal, and incomplete streamed markers become links only after they close.

Markdown embeds such as `![Clip](./clip.mp4)` use the shared media viewer for
supported image, audio, video, 3D model, and Office MIME types. Files are fetched through the same
authenticated file endpoint and rendered using typed Blob URLs, which are
released when their content or Session context leaves the view. The file client
assigns media MIME types from filename extensions; playback also requires browser
codec support. Raw HTML `<video>` tags remain escaped.
BMP uses `image/bmp`; ICO uses `image/vnd.microsoft.icon`, with the legacy
`image/x-icon` type also accepted for previews.
Remote preview reads are capped at 16 MiB; larger files use the streaming transfer queue.
Electron removes this size cap for this computer's files. Main determines locality
from the active server and the configured, non-revoked Team/Machine registration;
a machine-scoped request retains its existing authenticated endpoint. The renderer
cannot opt out of the remote limit.

For authorized local files, the actions are **Open** and **Show in Finder**
(**Show in File Explorer** on Windows, **Show in File Manager** on Linux) instead
of **Download**. Main resolves the Session resource again, checks that its target
is still local, and opens the canonical file path in the default application or
reveals it in the system file manager. Both remain available when the format
cannot be previewed, and neither copies the file or enqueues a transfer. Browser clients and remote files keep
the download action, which saves already loaded bytes through a browser download,
including files with unsupported preview formats. If the file resolves but its
preview cannot load, the action remains available and selects a local destination
for a normal transfer queue item. That transfer rechecks file access through the
same scoped file endpoint. Media loading failures retain a visible retry action.
Inline, focused, tab, and separate-window previews retain the original resource
request's Team, Machine, Session, and URI. Local directory grants belong to one
renderer document and are not serialized into another window's URL.

The daemon resolves filesystem references only. It does not proxy HTTP URLs,
remote `localhost` services, arbitrary network resources, or port-forwarded web
previews. References read the file currently present on the machine; they are not
immutable attachments or historical snapshots. The target must be reachable and
the file must still exist. No new central blob store or automatic artifact
snapshot policy is introduced.

## Implementation and validation

- `apps/daemon/src/files-service.ts`, `files-uploads.ts`, and `files-paths.ts` own
  machine filesystem behavior and staging; `files-channel.ts` binds the wire
  protocol to authorized peer access.
- `packages/client/src/files-rpc.ts` and `files-signaling.ts` own common remote
  requests and peer lifetime; `file-transfers.ts` owns queue behavior.
- `apps/desktop/src/main/files.ts`, `files-controller.ts`, and `files-grants.ts` own
  the Electron host, window/account lifetime, and local capability checks, while
  `packages/client/src/browser-files.ts` owns browser directory handles and OPFS.
- Shared files components and Agent Markdown/resource components live under
  `packages/components/src/components/`.

Focused tests cover binary framing, default local browsing and transfers without
folder selection, grant checks and revocation, captured Session paths, empty
files/directories, traversal rejection, conflict choices, concurrent
native commits, cancellation cleanup, queue aggregation, and renderer resources.
Run daemon tests with `mise exec -- node --test apps/daemon/src/files-*.test.ts
apps/daemon/src/authorized-peers.test.ts`; shared client/UI tests use
`mise exec -- pnpm --filter @deskfleet/desktop test`.

`mise run files:benchmark` measures native WebRTC uploads and downloads after the
connection is established, verifies each destination with SHA-256, and reports
per-round rates and medians. For a larger sample after building the addon, use
`mise exec -- node scripts/benchmark-files.ts --size-mib 256 --rounds 3`.
Measurements include queueing through destination commit; data generation,
connection setup, and hash verification are excluded. Run one benchmark at a
time and compare the same native build profile; real network rates also depend
on both machines and the network between them. CI checks bounded overlap,
ordered writes, and failure/cancellation behavior without timing thresholds.

For transport isolation, run `mise exec -- node scripts/benchmark-webrtc.ts
--size-mib 32 --rounds 3`. This connects two native peers on the same host,
exchanges SDP and host ICE candidates directly without STUN/TURN, and measures
delivery in both directions without filesystem or file RPC work. Timing includes
copying received messages into a preallocated buffer; allocation and SHA-256
verification are excluded. JSON output records throughput, process CPU,
event-loop delay, send-call latency, and backpressure retries. `--chunk-kib`,
`--window`, and `--retry-ms` allow controlled comparisons; the window limits
outstanding send calls, not the transport's internal buffering.

`files:benchmark` builds a debug addon. For optimized measurements, explicitly
run `mise run native:release`, then invoke either benchmark script directly so
the task does not rebuild debug. Both scripts accept `--addon /absolute/path`
to select a separately built native addon without replacing the installed one.
The file harness also accepts `--transport direct` to retain the transfer queue
and filesystem endpoints while bypassing WebRTC, and `--profile` to include
process, filesystem RPC, and native send metrics. RPC latency includes time in
the endpoint's serialized queue; it is not a measure of disk service time alone.
