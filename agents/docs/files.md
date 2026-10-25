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

The server issues a `files` peer grant with `files:read` and `files:write` actions.
The daemon checks the grant's actor, Team, target Machine, purpose, and lifetime,
then checks the required action on requests and outgoing response chunks.
Listing, stat, Session resource resolution, and reads require `files:read`;
destination creation, writes, completion, and cancellation require `files:write`.
Paths and channel labels do not grant authority. File access uses the daemon's
OS user permissions; Session association supplies path context, not a separate
filesystem sandbox.

File peers have their own lifetime, separate from Agent, terminal, and desktop
media peers. Switching tools, navigating to another page, changing
the selected machine, or disconnecting a desktop stream does not cancel the
queue. A functioning peer survives signaling loss under its existing grant.
Revocation, account changes, peer closure, or the grant's maximum 24-hour lifetime
end access and close the endpoint's unfinished writes. A later request may obtain
a new peer; pending writes are not automatically replayed on it.

Electron's main process owns its transfer manager, native WebRTC peers, local
filesystem endpoint, and narrow preload API. Transfers continue when a renderer
is hidden or destroyed and while the application stays in the tray. Application
quit closes this manager. The Web client owns its manager at page/account scope,
outside the selected machine's Vue/Pinia scope. Leaving that browser page ends
its transfers. The queue is not persisted or resumed across application restarts.

## Protocol and transfer behavior

The reliable ordered `deskfleet-files` DataChannel carries length-prefixed JSON
metadata followed by raw binary file bytes. File operations carry at most
128 KiB; wire fragments are at most 65,535 bytes and respect a smaller negotiated
transport limit. These are DataChannel message sizes, not UDP packet sizes;
WebRTC owns SCTP/DTLS fragmentation.
Metadata frames have an 8 MiB limit. Each peer allows 576 pending requests,
leaving 64 slots beyond the bulk transfer window for control operations, with at
most 64 MiB of pending request payload and 8 MiB of
pending request metadata. Encoded request and response queues allow 72 MiB,
including metadata; transport sends retain their existing backpressure limits.
The RPC idle timeout is 60 seconds without send or receive progress, so a large
window can drain normally on slower links without an absolute request deadline.
The provisional protocol remains version 1.

Bulk file copies pipeline up to 512 chunks across source
reads and destination writes. Writes enter the channel in offset order without
waiting for each preceding acknowledgement, so network round trips overlap with
disk work. The slot count is derived from a fixed 64 MiB file-content budget, so
larger operations do not increase the in-flight payload limit. This is a payload
budget; protocol copies and other buffers add to process memory. Only acknowledged
bytes advance progress. File completion waits for
all outstanding operations, including when cancellation or an error stops new
work. Native and browser receivers serialize each upload's mutations; browser
abort bypasses that queue to interrupt publication and reject pending writes.

The endpoint operations are `list`, `stat`, `resolve`, `read`, `begin`, `mkdir`,
`write`, `finish`, `commit`, and `abort`. An upload's paths are relative to its
selected root: the empty path names a root file or directory, and slash-separated
paths name descendants. Absolute paths, traversal segments, backslashes, and
alternate-stream colons are rejected in upload paths. Reads and writes check
chunk sizes and offsets; writes are sequential. Source size and modification
time detect changes while copying.

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
part of the path. The current UI downloads file links rather than opening a
line-aware editor.

Images are fetched through the same authenticated file endpoint and rendered
using locally created Blob URLs. The renderer permits `blob:` image sources and
releases those URLs when their content or Session context leaves the view.
BMP uses `image/bmp`; ICO uses `image/vnd.microsoft.icon`, with the legacy
`image/x-icon` type also accepted for previews.
Preview reads are capped at 16 MiB; larger files use the streaming transfer queue.
Downloading a file link selects a local destination and creates a normal queue
item. Loading failures retain a visible retry action.

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
- `apps/desktop/src/main/files.ts` owns the Electron host, while
  `packages/client/src/browser-files.ts` owns browser directory handles and OPFS.
- Shared files components and Agent Markdown/resource components live under
  `packages/components/src/components/`.

Focused tests cover binary framing, grant checks and revocation, captured Session
paths, empty files/directories, traversal rejection, conflict choices, concurrent
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
