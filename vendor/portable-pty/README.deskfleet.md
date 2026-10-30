# DeskFleet portable-pty patch

This directory contains the source, examples, manifests, and MIT license from
the crates.io `portable-pty` 0.9.0 package. Its archive SHA-256 is
`b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`;
the package records upstream commit
`f8921727a11b9f8b073e8c24821d72fd41283500`, directory `pty`.
Registry bookkeeping and the package's own lockfile are omitted. The workspace
lockfile owns dependency resolution. Upstream sources are kept intact except
for the change below; they are excluded from workspace membership.

## Local change

In `src/unix.rs`, PTY spawning marks inherited descriptors above stderr with
`FD_CLOEXEC` instead of immediately closing them between fork and exec. Linux
Electron intercepts `close()` and aborts when these inherited descriptors are
still tracked by Chromium's `ScopedFD` ownership table. Deferring cleanup to
exec also preserves Rust's error-reporting pipe when exec fails. Descriptor
flags in the parent and the existing public `close_random_fds()` behavior stay
unchanged. Windows sources are unchanged.

This adapts the approach in
[wezterm/wezterm#7743](https://github.com/wezterm/wezterm/pull/7743).
[Chromium's FD ownership contract](https://chromium.googlesource.com/chromium/src/+/HEAD/base/files/scoped_file.h)
describes why inherited ownership tracking conflicts with bulk closes after
fork. No Chromium ownership checks are disabled.

`mise run desktop:smoke-native-terminal` exercises the native addon from the
Electron browser main process. Native terminal tests also check that inherited
descriptors do not survive exec and that the parent retains its descriptors.

When a released upstream version contains the equivalent fix, upgrade the
workspace dependency, remove the root `[patch.crates-io]` entry and this
directory, and retain those regression tests.
