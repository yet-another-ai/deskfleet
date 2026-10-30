import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

assert.equal(process.platform, "linux", "The Chromium FD ownership regression runs on Linux")
const directory = await mkdtemp(join(tmpdir(), "deskfleet-native-terminal-smoke-"))
const executable = createRequire(import.meta.url)("electron") as string
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let diagnostics = ""

try {
  await Promise.all([
    build({ entryPoints: [join(import.meta.dirname, "fixtures/native-terminal-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" }),
    // The bundled native loader resolves the addon beside its JavaScript entry.
    copyFile(resolve(import.meta.dirname, "../../../crates/node/deskfleet.node"), join(directory, "deskfleet.node")),
  ])
  const child = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${join(directory, "profile")}`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  child.stderr.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, 30_000)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolveExit({ code, signal }))
    })
    assert.equal(timedOut, false, "Electron native terminal smoke timed out")
    assert.deepEqual(result, { code: 0, signal: null }, "Electron native terminal smoke failed")
    assert.doesNotMatch(diagnostics, /FD ownership violation/u)
    console.log("Electron main/native PTY: input/output, nonzero exit, and exec failure reporting passed")
  } finally { clearTimeout(timer) }
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
