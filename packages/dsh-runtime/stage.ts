import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { dirname, join, resolve } from "node:path"

const DEVELOPMENT_ARTIFACT = /\.(?:map|pdb)$/iu
const TYPE_DECLARATION = /\.d\.(?:ts|mts|cts)$/iu

/**
 * Remove files that only serve development tooling. The deployed tree is a
 * runtime dependency graph; source maps, type declarations, and debug symbols
 * are not loaded by DSH and otherwise add tens of thousands of small files to
 * every install. TypeScript sources stay because the plugin loader resolves
 * them alongside emitted JavaScript.
 */
export async function pruneDshArtifacts(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await pruneDshArtifacts(path)
    } else if (entry.isFile() && (DEVELOPMENT_ARTIFACT.test(entry.name) || TYPE_DECLARATION.test(entry.name))) {
      await unlink(path)
    }
  }
}

/** Preserve dynamic plugins and native helpers; standalone releases also need a Node host. */
export async function stageDsh(destination: string, host: "node" | "electron"): Promise<void> {
  const root = resolve(import.meta.dirname, "../..")
  await rm(destination, { recursive: true, force: true })
  // Use the dedicated deploy lockfile; legacy deploy re-resolves packages from registry metadata.
  // Workspace installation already validates supply-chain policy. Trust that locked graph so
  // offline deployment does not require a second set of registry metadata. Unused UI patches
  // are allowed because they are outside this production dependency graph.
  execFileSync("mise", ["exec", "--", "pnpm",
    "--filter", "@deskfleet/dsh-runtime", "deploy", "--prod",
    "--node-linker=hoisted", "--offline", "--frozen-lockfile", "--trust-lockfile", destination,
  ], { cwd: root, env: { ...process.env, PNPM_CONFIG_ALLOW_UNUSED_PATCHES: "true" }, stdio: "inherit" })
  await pruneDshArtifacts(destination)
  // The helper must work outside source checkouts, including hosts that cannot strip
  // TypeScript beneath node_modules. Keep its executable and static overlay at the runtime root.
  await writeFile(join(destination, "helper.js"), stripTypeScriptTypes(
    await readFile(join(import.meta.dirname, "src/helper.ts"), "utf8"), { mode: "strip" }))
  await copyFile(join(import.meta.dirname, "src/account-acp.yml"), join(destination, "account-acp.yml"))
  await copyFile(join(import.meta.dirname, "src/credentials-acp.yml"), join(destination, "credentials-acp.yml"))
  if (host === "electron") return
  const bin = join(destination, "bin")
  await mkdir(bin, { recursive: true })
  const node = join(bin, process.platform === "win32" ? "node.exe" : "node")
  await copyFile(process.execPath, node)
  await chmod(node, 0o755)
  // Official Node distributions put LICENSE beside node.exe, or above bin/node.
  const nodeRoot = process.platform === "win32" ? dirname(process.execPath) : resolve(dirname(process.execPath), "..")
  await copyFile(join(nodeRoot, "LICENSE"), join(destination, "LICENSE.node"))
}

if (import.meta.main) {
  const host = process.argv[2]
  if (host !== "node" && host !== "electron") throw new Error("Usage: stage.ts <node|electron> [destination]")
  await stageDsh(resolve(process.argv[3] ?? join(import.meta.dirname, "dist")), host)
}
