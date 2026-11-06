import { bundledDshRuntime, electronDshHost, sourceDshRuntime } from "@deskfleet/dsh-runtime"
import { smokeDsh } from "@deskfleet/dsh-runtime/smoke"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

if (process.argv[2] === "--packaged") {
  const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"
  const arch = process.arch === "x64" ? "" : `-${process.arch}`
  const output = resolve(import.meta.dirname, "../release", `${platform}${arch}${platform === "mac" ? "" : "-unpacked"}`)
  const contents = platform === "mac" ? join(output, "deskfleet.app", "Contents") : output
  const directory = join(contents, platform === "mac" ? "Resources" : "resources", "dsh")
  const executable = platform === "mac" ? join(contents, "MacOS", "deskfleet")
    : join(contents, process.platform === "win32" ? "deskfleet.exe" : "deskfleet")
  assert.equal(existsSync(join(directory, "bin", process.platform === "win32" ? "node.exe" : "node")), false)
  await smokeDsh(bundledDshRuntime(directory, electronDshHost(executable)))
} else {
  // Pass a runtime directory and executable to check a relocated packaged application.
  const host = electronDshHost(process.argv[3] ?? createRequire(import.meta.url)("electron") as string)
  await smokeDsh(process.argv[2]
    ? bundledDshRuntime(resolve(process.argv[2]), host)
    : sourceDshRuntime(import.meta.url, host))
}
