import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { DaemonClient } from "../../daemon/src/control-client.ts"
import { startDaemon } from "../../daemon/src/daemon.ts"
import { daemonDiscoveryPath, readDaemonDiscovery } from "../../daemon/src/control-discovery.ts"
import type { LocalAgentSmokeContext, LocalAgentSmokeResult } from "./fixtures/local-agent-main.ts"

const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-agent-smoke-")))
const executable = createRequire(import.meta.url)("electron") as string
const appPath = resolve(import.meta.dirname, "..")
const daemonDirectory = join(directory, "daemon")
const profileDirectory = join(directory, "profile")
const checkoutPath = join(directory, "checkout")
const rendererDirectory = join(appPath, "out/renderer")
const preloadPath = join(directory, "local-preload.cjs")
const mainEntry = join(appPath, "out/main/index.js")
let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let diagnostics = ""

async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  if (electron.connected) electron.send({ close: true })
  const timer = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited
  clearTimeout(timer)
}

async function launchClient(phase: LocalAgentSmokeContext["phase"], previous?: LocalAgentSmokeResult): Promise<LocalAgentSmokeResult> {
  const context: LocalAgentSmokeContext = { phase, rendererDirectory, preloadPath, mainEntry, profileDirectory, daemonDirectory, checkoutPath, ...previous }
  const env: NodeJS.ProcessEnv = { ...process.env, DESKFLEET_DAEMON_DIRECTORY: daemonDirectory }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${profileDirectory}`, `--local-agent-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."), env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const client = electron
  exited = new Promise(resolveExit => { client.once("exit", () => resolveExit()); client.once("error", () => resolveExit()) })
  client.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  try {
    return await new Promise<LocalAgentSmokeResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error(`Electron local Agent ${phase} smoke timed out`)), 60_000)
      const fail = (error: unknown) => { clearTimeout(timer); rejectResult(error) }
      client.once("error", fail)
      client.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
      client.on("message", (message: { result?: LocalAgentSmokeResult; error?: string }) => {
        if (message.error) fail(new Error(`Electron local Agent ${phase} phase failed: ${message.error}`))
        if (message.result) { clearTimeout(timer); resolveResult(message.result) }
      })
    })
  } finally { await stopClient() }
}

async function discoveryExists(): Promise<boolean> {
  try { await stat(daemonDiscoveryPath(daemonDirectory)); return true }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function shutdownDaemon(): Promise<void> {
  if (!await discoveryExists()) return
  let client: DaemonClient
  try { client = await DaemonClient.connect(() => {}, () => {}, daemonDirectory) }
  catch (error) {
    // A crashed app leaves stale discovery; cleanup must not mask the failure that caused it.
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) return
    throw error
  }
  try { await client.call("shutdown", {}) }
  finally { client.close() }
  const deadline = Date.now() + 15_000
  while (await discoveryExists()) {
    if (Date.now() > deadline) throw new Error("Isolated local Agent did not finish shutdown")
    await delay(50)
  }
}

try {
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/local-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" })
  await Promise.all([stat(join(rendererDirectory, "index.html")), stat(preloadPath), stat(mainEntry)])
  await Promise.all([mkdir(checkoutPath), mkdir(profileDirectory)])
  await Promise.all([
    build({ entryPoints: [join(import.meta.dirname, "fixtures/local-agent-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" }),
    // The bundled native loader resolves the addon beside its JavaScript entry.
    copyFile(join(appPath, "out/main/deskfleet.node"), join(directory, "deskfleet.node")),
  ])
  assert.equal(await discoveryExists(), false)
  const created = await launchClient("start")
  assert.ok(created.workspaceId && created.terminalId && created.stoppedTerminalId && created.providerId)
  assert.equal(created.survivedWindowClose, true, "The hosted daemon must outlive the app's windows")
  assert.equal(await discoveryExists(), false, "Quitting the app must stop the daemon it hosts")
  const restarted = await launchClient("restart", created)
  assert.equal(restarted.providerId, created.providerId, "Provider identity must survive an app restart")
  assert.notEqual(restarted.daemonIdentity, created.daemonIdentity, "A relaunched app must host a new daemon")
  assert.equal(await discoveryExists(), false, "Turning off must remove daemon discovery")
  assert.equal(JSON.parse(await readFile(join(profileDirectory, "settings.json"), "utf8")).localAgentEnabled, false)
  await launchClient("disabled")
  assert.equal(await discoveryExists(), false, "Persisted disabled preference must prevent daemon startup")
  // A standalone daemon, such as the headless executable, is reused and outlives the app.
  const external = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory: daemonDirectory, requestScreenCaptureAccess: async () => false })
  try {
    const identity = createHash("sha256").update(JSON.stringify(await readDaemonDiscovery(daemonDirectory))).digest("hex")
    assert.equal((await launchClient("external")).daemonIdentity, identity, "The app must reuse a separately running daemon")
    const observer = await DaemonClient.connect(() => {}, () => {}, daemonDirectory)
    try { assert.equal((await observer.call("catalogList", {})).workspaces[0]?.id, created.workspaceId, "Quitting the app must leave a separate daemon running") }
    finally { observer.close() }
  } finally { await external.close() }
  console.log("Production Electron local Agent: provider creation/editing/removal, a failed provider test, icon selection and restart persistence, startup permission denial, Settings off/on, catalog refresh, terminal interruption, window-independent and app-bound lifetime, standalone daemon reuse, and disabled startup passed")
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  const log = await readFile(join(daemonDirectory, "daemon.log"), "utf8").catch(() => "")
  if (log) console.error(log)
  throw error
} finally {
  await stopClient()
  try { await shutdownDaemon() }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
