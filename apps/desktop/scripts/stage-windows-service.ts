import { execFileSync } from "node:child_process"
import { copyFile, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

// The desktop and maintenance services are optional installed components, but
// every Windows installer carries them so enabling locked-desktop access needs
// no separate download.
if (process.platform === "win32") {
  const root = resolve(import.meta.dirname, "../../..")
  const target = execFileSync("rustc", ["--print", "host-tuple"], { cwd: root, encoding: "utf8" }).trim()
  // CI's workspace release build already produced these executables.
  if (process.env.DESKFLEET_NATIVE_PREBUILT !== "1") {
    execFileSync(
      "cargo",
      ["build", "-p", "deskfleet-desktop-service", "-p", "deskfleet-maintenance-service", "--release", "--locked", "--target", target],
      { cwd: root, stdio: "inherit" },
    )
  }
  const output = resolve(import.meta.dirname, "../out/windows")
  await mkdir(output, { recursive: true })
  const desktopExe = join(output, "deskfleet-desktop-service.exe")
  const maintenanceExe = join(output, "deskfleet-maintenance-service.exe")
  await copyFile(join(root, "target", target, "release", "deskfleet-desktop-service.exe"), desktopExe)
  await copyFile(join(root, "target", target, "release", "deskfleet-maintenance-service.exe"), maintenanceExe)

  const manifestPath = join(output, "deskfleet-desktop-service.manifest.json")
  const signingKey = process.env.WINDOWS_SERVICE_SIGNING_KEY?.trim()
  if (signingKey) {
    const [{ readReleaseVersions }, { signServiceFile }] = await Promise.all([
      import("../../../scripts/release-version.ts"),
      import("../../../scripts/windows-service-signing.ts"),
    ])
    const version = readReleaseVersions(root).desktop
    const keyId = process.env.WINDOWS_SERVICE_SIGNING_KEY_ID?.trim() || "v1"
    signServiceFile(
      desktopExe,
      version,
      manifestPath,
      signingKey,
      keyId,
      process.env.DESKFLEET_WINDOWS_SERVICE_PUBLIC_KEYS,
    )
  } else {
    await rm(manifestPath, { force: true })
  }
}
