import { execFileSync } from "node:child_process"
import { copyFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

// The service is an optional installed component, but every Windows installer
// carries it so enabling locked-desktop access needs no separate download.
if (process.platform === "win32") {
  const root = resolve(import.meta.dirname, "../../..")
  const target = execFileSync("rustc", ["--print", "host-tuple"], { cwd: root, encoding: "utf8" }).trim()
  // CI's workspace release build already produced this executable.
  if (process.env.DESKFLEET_NATIVE_PREBUILT !== "1") {
    execFileSync("cargo", ["build", "-p", "deskfleet-desktop-service", "--release", "--locked", "--target", target], { cwd: root, stdio: "inherit" })
  }
  const output = resolve(import.meta.dirname, "../out/windows")
  await mkdir(output, { recursive: true })
  await copyFile(join(root, "target", target, "release", "deskfleet-desktop-service.exe"), join(output, "deskfleet-desktop-service.exe"))
}
