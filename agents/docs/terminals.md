# Terminals over WebRTC

The Electron terminal uses xterm.js and a reliable, ordered WebRTC DataChannel.
It negotiates a data-only peer: no video/audio tracks, capture devices, codec
selection, or screen-recording permission are involved. SDP and ICE reuse the
authenticated local daemon signaling connection used by desktop streaming.

## Ownership and lifecycle

`TerminalSessions` in the TypeScript daemon owns native PTYs. The reusable Rust
backend uses `portable-pty`, exposed through the thin `NativeTerminal` napi-rs
binding. Spawn, write, resize, wait, and termination run outside Node's event
loop. The daemon continuously consumes native output even with no viewer.
On Windows, portable-pty asks ConPTY to inherit the cursor. ConPTY writes
`ESC[6n` when the child connects and will not let that process run until the
host reports a cursor position. The PTY reader answers that startup query with
the origin of the still-empty session and removes the query from the output.
Later cursor queries stay in the stream so the attached terminal can answer
with the cursor it has rendered.

The UI creates machine-scoped terminals in the daemon user's home directory,
in a Workspace's first path with **Open terminal in default directory**, or in
a selected directory with **Open terminal here**.
The working directory is independent of resource ownership: those terminals
remain under the local machine, and editing/deleting a Workspace does not retarget
or close them. Local Workspace directory configuration is connected; remote machine
enrollment remains unimplemented.

Navigating away detaches the view. Losing a peer, reloading the renderer, or
quitting Electron closes the transport without terminating the shell. On startup
the client lists daemon sessions; attaching an existing ID does not spawn a new
process. One client can control a terminal at a time. Each shell has its own tab;
switching tabs detaches the previous view without stopping that shell. Closing a
tab is an explicit **Hang up** action: it terminates only that shell and deletes
its history. A natural shell exit reports its exit code and retains the tab and
history until hangup.

Daemon shutdown terminates its PTYs but preserves their history. After restart,
previously running sessions become `interrupted`, with read-only history. Dialing
an interrupted session does not start a replacement shell. Keeping live
PTY processes across daemon restarts requires a separate recoverable backend.

## Wire contract and flow control

`apps/daemon/src/terminal-protocol.ts` owns the provisional TypeScript contract.
Shell lifecycle belongs to authenticated signaling: `terminalList` returns the
catalog, `terminalDial` creates or resumes a stable terminal ID, and
`terminalHangup` ends it. Creation uses a client-selected ID so retrying a dial
cannot create a duplicate shell. Resume requires an existing ID. Session changes
and hangups are broadcast to authenticated clients, keeping their tabs current.
Hangup works without a live WebRTC data peer.

The `deskfleet-terminal` channel carries attach, detach, input and resize requests
plus output, replay-ready, exit and hangup events. A terminal must have been
dialed on the authenticated signaling connection before the data peer may attach.
Terminal input and output never cross the Electron preload or signaling socket.
A desktop media peer cannot invoke the terminal dispatcher.

Output and input preserve raw bytes using base64 in JSON messages. This also
preserves UTF-8 characters split across reads. Output is sent in chunks of at
most 8 KiB, with one chunk outstanding per attachment. The client acknowledges
only after xterm consumes it. Input is chunked and waits for each PTY write; the
renderer bounds queued paste/input to 256 KiB. Resize sends terminal columns and
rows, not pixel dimensions.

## Durable history

The daemon saves the full output byte stream under
`<daemon directory>/terminals/<terminal ID>/output.bin`, with session metadata in
`session.json`. The default daemon directory is `~/.deskfleet`; the existing
`DESKFLEET_DAEMON_DIRECTORY` override also selects history storage. Directories
and files use private permissions. Output is flushed to disk before its offset
is published to viewers. Metadata is replaced atomically, and creation/deletion
use staged directories so incomplete operations cannot break recovery.

History remains until explicit hangup; disconnect, client replacement, natural
exit, and daemon restart do not delete it. Replay reads bounded chunks from disk
instead of keeping the transcript in daemon memory. Slow viewers continue from
their acknowledged offset without discarding earlier output. An attachment
receives `ready` after consuming the history present when it attached, allowing
live input even if the process continues producing output.

The renderer rebuilds its terminal from the recorded bytes. It initially keeps
5,000 scrollback lines locally; **Load more history** increases that window and
replays the retained daemon history. This client memory limit never truncates
the daemon's files. History is terminal output, including control sequences;
keystrokes that the shell does not echo are not recorded separately.

## Running and validation

Start `mise run daemon:dev` and `mise run desktop:dev` separately. Use **New
terminal** beside the real local machine and type directly into the terminal.
Use the tab bar to switch shells or open another, and its hangup action to close
one explicitly. Reopening a sidebar terminal attaches to its existing process.

`mise run check` covers native PTY behavior, daemon lifetime and flow control,
signaling ownership, and renderer input/output. `mise run desktop:smoke-terminal`
runs real Chromium, production preload and IPC handlers, a daemon, and a native
PTY. It checks data-only negotiation, UTF-8 output rendered by xterm, input,
resize, two independent shells, full history beyond 256 KiB recovered by a fresh
Electron process, the same shell identity, and signaling hangup after the data
peer has closed. Daemon tests additionally cover restart recovery, incomplete
creation/deletion, and hangup while a PTY write is blocked.

The UI uses local signaling and direct ICE. The native transport accepts
STUN/TURN configuration. Selecting another machine in the UI requires integrating
cross-machine enrollment, scoped remote authorization, central signaling, and
client TURN configuration.
