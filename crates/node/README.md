# deskfleet-node / @deskfleet/native

This crate exposes `deskfleet-native` through napi-rs. Its private pnpm package,
`@deskfleet/native`, exports `nativeInfo()` with the addon version and Rust target
OS/architecture, `createPeer()` for WebRTC, and explicit
`captureDisplays()` / `supportedVideoCodecs(displayId)` capability queries.

`desktopSupported()` probes capture and hardware encoding without a consent
dialog. `linuxDesktopBackend()` identifies the selected `wayland`, `x11`, or
unavailable (`null`) session without opening a display. The daemon uses
`requestLinuxDesktopAccess(directory)`, `checkLinuxDesktopAccess()`, and
`closeLinuxDesktopAccess()` for both Linux backends. Wayland retains one shared
Portal grant; `waitLinuxDesktopAccessChange()` wakes its owner when that grant
changes, including when remote input disconnects. Viewer cleanup does not own
the grant. Its directory stores only the local restore token, never sent to viewers.
X11 checks the user's X server access without a Portal dialog or token; capture
and input workers own their connections, and the authorization watch returns
`null`. Blocking X11 checks run off Node's event loop.

`createTerminal({ cwd, cols, rows })` starts the OS user's default shell in a
native PTY. Terminals provide async byte `write()`, `resize()`, `nextEvent()`, and
`close()` methods. The daemon must continuously drain events into its session
durable history and retain the terminal independently of any peer; closing a peer does
not terminate the shell. Explicit terminal close or daemon shutdown terminates
and reaps the owned process. Natural exit delivers queued output before the exit
event. PTY operations run off Node's event loop, and the native output queue is
bounded to 1 MiB.

Daemon-owned setup operations can pass `command`, `args`, and `env` to launch an
explicit program in the same PTY lifecycle. Arguments are passed directly and
environment overrides extend the inherited environment. These launch settings
are internal to the daemon and are not accepted by the public terminal dial API.

Peers provide async SDP/ICE operations, DataChannel send/receive events,
`startDesktop()` / `stopDesktop()`, and `close()`. Capture and encoding stay in
Rust; no raw GPU frames pass through JavaScript. Importing the package or
creating a data-only peer does not initialize a graphical subsystem. See
[native media](../../agents/docs/media.md) for lifecycle and platform support.

Build from the repository root:

```sh
mise run native:debug
mise run native:release
```

The napi-rs CLI builds `deskfleet.node` and generates `bindings.d.ts`. Keep the
declarations in source control and regenerate them when the Rust exports change;
the binary is ignored.

The TypeScript loader calls `process.dlopen()` on the built addon. For a SEA
executable it instead extracts the embedded `deskfleet.node` asset into a private
temporary directory before loading.

See the [daemon guide](../../apps/daemon/README.md) for packaging and the
[CI workflow](../../agents/docs/ci.md) for platform checks.
