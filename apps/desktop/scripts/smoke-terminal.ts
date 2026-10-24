import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { startDaemon } from "../../daemon/src/daemon.ts"
import { rendererContentSecurityPolicy } from "../src/shared/renderer-csp.ts"

const directory = await mkdtemp(join(tmpdir(), "deskfleet-terminal-smoke-"))
const fixtures = join(import.meta.dirname, "fixtures")
const executable = createRequire(import.meta.url)("electron") as string
const controlDirectory = join(directory, "daemon")
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let diagnostics = ""
let clientNumber = 0

async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  if (electron.connected) electron.send({ close: true })
  const timer = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited
  clearTimeout(timer)
}

async function launchClient(context: Record<string, unknown>): Promise<Record<string, unknown>> {
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${join(directory, `profile-${++clientNumber}`)}`, `--terminal-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, DESKFLEET_DAEMON_DIRECTORY: controlDirectory },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  exited = new Promise(resolveExit => { electron!.once("exit", () => resolveExit()); electron!.once("error", () => resolveExit()) })
  electron.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  try {
    return await new Promise<Record<string, unknown>>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error("Electron terminal smoke timed out")), 40_000)
      const fail = (error: unknown) => { clearTimeout(timer); rejectResult(error) }
      electron!.once("error", fail)
      electron!.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
      electron!.on("message", (message: { result?: Record<string, unknown>; error?: string }) => {
        if (message.error) fail(new Error(message.error))
        if (message.result) { clearTimeout(timer); resolveResult(message.result) }
      })
    })
  } finally {
    await stopClient()
  }
}

try {
  await Promise.all([
    build({ entryPoints: [join(fixtures, "terminal-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" }),
    build({ entryPoints: [join(fixtures, "terminal-preload.ts")], outfile: join(directory, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" }),
    build({ entryPoints: [join(fixtures, "terminal-renderer.ts")], outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", target: "chrome140" }),
  ])
  await writeFile(join(directory, "index.html"), `<!doctype html>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rendererContentSecurityPolicy(true)}">
<link rel="stylesheet" href="/renderer.css"><div id="terminal"></div><script type="module" src="/renderer.js"></script>`)
  daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory, requestScreenCaptureAccess: async () => null })
  const first = await launchClient({ phase: "write" })
  assert.equal(daemon.terminals.list().length, 2)
  assert.ok((await stat(join(controlDirectory, "terminals", String(first.terminalId), "output.bin"))).size > 300_000)
  const result = await launchClient({ ...first, phase: "resume" })
  assert.equal(result.dataOnly, true)
  assert.equal(result.exitCode, 7)
  assert.deepEqual(await readdir(join(controlDirectory, "terminals")), [])
  console.log("Electron/native PTY: dial, independent shells, durable full replay on a fresh client, and signaling hangup passed", result)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stopClient()
  await daemon?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
