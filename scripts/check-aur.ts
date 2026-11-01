import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Build from the generated, checksummed sources as an ordinary makepkg user.
// All package installation/removal happens inside the disposable Arch container.
const [directory, option, ...extra] = process.argv.slice(2)
assert.ok(directory && (!option || option === "--gui") && extra.length === 0,
  "Usage: node scripts/check-aur.ts <generated-package-directory> [--gui]")
assert.equal(process.platform, "linux", "Arch package verification requires Linux")
const staging = mkdtempSync(join(tmpdir(), "deskfleet-arch-check-"))
try {
  // The smoke runs as the container's unprivileged builder, not as the host
  // user that created mkdtemp's otherwise private directory.
  chmodSync(staging, 0o755)
  mkdirSync(join(staging, "scripts"))
  mkdirSync(join(staging, "apps/daemon"), { recursive: true })
  copyFileSync(new URL("./smoke-linux-package.ts", import.meta.url), join(staging, "scripts/smoke-linux-package.ts"))
  copyFileSync(new URL("../apps/daemon/package.json", import.meta.url), join(staging, "apps/daemon/package.json"))
  execFileSync("docker", [
    "run", "--rm", "--security-opt", "seccomp=unconfined",
    "--env", `DESKFLEET_CHECK_GUI=${option === "--gui" ? "1" : "0"}`,
    "--volume", `${resolve(directory)}:/package`,
    "--volume", `${staging}:/verification:ro`,
    "--volume", `${process.execPath}:/usr/local/bin/node:ro`,
    "docker.io/library/archlinux:base", "bash", "-euo", "pipefail", "-c", `
      pacman -Syu --noconfirm --needed base-devel namcap
      useradd --create-home builder
      echo 'builder ALL=(ALL) NOPASSWD: /usr/bin/pacman' > /etc/sudoers.d/builder
      cp -a /package /tmp/package
      chown -R builder:builder /tmp/package
      cd /tmp/package
      runuser -u builder -- makepkg --syncdeps --noconfirm
      runuser -u builder -- makepkg --printsrcinfo > /package/.SRCINFO
      namcap PKGBUILD ./*.pkg.tar.zst | tee /package/namcap.log
      pacman -U --noconfirm ./*.pkg.tar.zst
      # Reinstall exercises package ownership and existing-file handling.
      pacman -U --noconfirm ./*.pkg.tar.zst
      pacman -Qkk deskfleet-bin
      if [[ "$DESKFLEET_CHECK_GUI" == 1 ]]; then
        pacman -S --noconfirm --needed xorg-server-xvfb dbus
        runuser -u builder -- dbus-run-session -- xvfb-run -a \
          node /verification/scripts/smoke-linux-package.ts / --layout=arch --gui
      fi
      pacman -R --noconfirm deskfleet-bin
      test ! -e /usr/bin/deskfleet
      test ! -e /opt/deskfleet
      test ! -e /usr/share/applications/io.github.yet_another_ai.deskfleet.desktop
    `,
  ], { stdio: "inherit" })
} finally {
  rmSync(staging, { recursive: true, force: true })
}
