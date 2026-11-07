import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Install the generated packages in clean target distributions and run the
// installed application. The host only provides Docker, Node, and the smoke test.
const [directory, ...options] = process.argv.slice(2)
assert.ok(directory && options.every(option => option === "--gui") && options.length <= 1,
  "Usage: node scripts/check-linux-release.ts <package-directory> [--gui]")
assert.equal(process.platform, "linux", "Linux package verification requires Linux")
const gui = options.includes("--gui")
const packages = readdirSync(resolve(directory))
const debs = packages.filter(name => name.endsWith(".deb"))
const rpms = packages.filter(name => name.endsWith(".rpm"))
assert.ok(debs.length > 0 || rpms.length > 0, "The package directory has no .deb or .rpm files")

const staging = mkdtempSync(join(tmpdir(), "deskfleet-linux-check-"))
try {
  chmodSync(staging, 0o755)
  mkdirSync(join(staging, "scripts"))
  mkdirSync(join(staging, "apps/daemon"), { recursive: true })
  copyFileSync(new URL("./smoke-linux-package.ts", import.meta.url), join(staging, "scripts/smoke-linux-package.ts"))
  copyFileSync(new URL("../apps/daemon/package.json", import.meta.url), join(staging, "apps/daemon/package.json"))

  const run = (image: string, script: string) => execFileSync("docker", [
    "run", "--rm", "--shm-size=1g", "--security-opt", "seccomp=unconfined",
    "--env", `DESKFLEET_CHECK_GUI=${gui ? "1" : "0"}`,
    "--volume", `${resolve(directory)}:/package:ro`,
    "--volume", `${staging}:/verification:ro`,
    "--volume", `${process.execPath}:/usr/local/bin/node:ro`,
    image, "bash", "-euo", "pipefail", "-c", script,
  ], { stdio: "inherit" })

  if (debs.length > 0) {
    run("ubuntu:24.04", `
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y /package/*.deb xvfb xauth dbus
      apt-get remove -y deskfleet
      test ! -e /usr/lib/deskfleet
      apt-get install -y /package/*.deb
      test "$(stat -c '%a' /usr/lib/deskfleet/chrome-sandbox)" = "4755"
      useradd --create-home builder
      if [ "$DESKFLEET_CHECK_GUI" = "1" ]; then gui=--gui; else gui=; fi
      runuser -u builder -- dbus-run-session -- xvfb-run -a \\
        node /verification/scripts/smoke-linux-package.ts / --layout=deb $gui
      apt-get remove -y deskfleet
      test ! -e /usr/bin/deskfleet
      test ! -e /usr/lib/deskfleet
      test ! -e /usr/share/applications/io.github.yet_another_ai.deskfleet.desktop
    `)
  }

  if (rpms.length > 0) {
    run("fedora:latest", `
      dnf install -y /package/*.rpm xorg-x11-server-Xvfb xauth dbus dbus-daemon dbus-tools
      rpm -q deskfleet
      test "$(stat -c '%a' /usr/lib/deskfleet/chrome-sandbox)" = "4755"
      dnf remove -y deskfleet
      test ! -e /usr/lib/deskfleet
      dnf install -y /package/*.rpm
      useradd --create-home builder
      if [ "$DESKFLEET_CHECK_GUI" = "1" ]; then gui=--gui; else gui=; fi
      runuser -u builder -- dbus-run-session -- xvfb-run -a \\
        node /verification/scripts/smoke-linux-package.ts / --layout=rpm $gui
      dnf remove -y deskfleet
      test ! -e /usr/bin/deskfleet
      test ! -e /usr/lib/deskfleet
      test ! -e /usr/share/applications/io.github.yet_another_ai.deskfleet.desktop
    `)
  }
  console.log(`Linux distribution package smoke passed: ${[...debs, ...rpms].join(", ")}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
