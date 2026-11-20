import { execFileSync } from "node:child_process"
import { copyFile, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { join, resolve } from "node:path"

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

/** Preserve the dynamic plugins and native helpers for the Desktop runtime. */
export async function stageDsh(destination: string): Promise<void> {
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
}
