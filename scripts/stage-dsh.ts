import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/** Keep the upstream plugin tree and native helpers intact, with a private Node runtime. */
export async function stageDsh(destination: string): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  await rm(destination, { recursive: true, force: true })
  // The runtime has no workspace adapter/UI dependencies, so their patches are unused here.
  execFileSync("mise", ["exec", "--", "pnpm",
    "--filter", "@deskfleet/dsh-runtime", "deploy", "--prod", "--legacy",
    "--node-linker=hoisted", "--offline", "--frozen-lockfile", destination,
  ], { cwd: root, env: { ...process.env, PNPM_CONFIG_ALLOW_UNUSED_PATCHES: "true" }, stdio: "inherit" })
  const bin = join(destination, "bin")
  await mkdir(bin, { recursive: true })
  const node = join(bin, process.platform === "win32" ? "node.exe" : "node")
  await copyFile(process.execPath, node)
  await chmod(node, 0o755)
  // Official Node distributions put LICENSE beside node.exe, or above bin/node.
  const nodeRoot = process.platform === "win32" ? dirname(process.execPath) : resolve(dirname(process.execPath), "..")
  await copyFile(join(nodeRoot, "LICENSE"), join(destination, "LICENSE.node"))
}

if (import.meta.main) await stageDsh(resolve(process.argv[2] ?? "packages/dsh-runtime/dist"))
