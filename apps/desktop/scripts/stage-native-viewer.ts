import { execFileSync } from "node:child_process"
import { copyFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

// The native decoder is available on Linux, Windows, and macOS. Keep the executable
// outside ASAR so the desktop host can launch its independent window loop.
if (process.platform === "linux" || process.platform === "win32" || process.platform === "darwin") {
  const root = resolve(import.meta.dirname, "../../..")
  const target = execFileSync("rustc", ["--print", "host-tuple"], { cwd: root, encoding: "utf8" }).trim()
  execFileSync("cargo", ["build", "-p", "deskfleet-desktop-viewer", "--bin", "deskfleet-viewer", "--release", "--locked", "--target", target], { cwd: root, stdio: "inherit" })
  const output = resolve(import.meta.dirname, "../out/native")
  await mkdir(output, { recursive: true })
  const name = process.platform === "win32" ? "deskfleet-viewer.exe" : "deskfleet-viewer"
  await copyFile(join(root, "target", target, "release", name), join(output, name))
}
