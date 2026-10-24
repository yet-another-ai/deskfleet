import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { DaemonClient } from "../../daemon/src/control-client.ts"
import { createPeer } from "../../../crates/node/index.ts"

// Exercise the real package entry, including its static imports and startup
// routing. Feature fixtures replace main and cannot detect import-time crashes.
const appPath = resolve(import.meta.dirname, "..")
const executable = createRequire(import.meta.url)("electron") as string
const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-startup-smoke-")))
const profile = join(directory, "profile")
const daemonDirectory = join(directory, "daemon")
const env: NodeJS.ProcessEnv = { ...process.env, DESKFLEET_DAEMON_DIRECTORY: daemonDirectory }
delete env.ELECTRON_RUN_AS_NODE
delete env.DESKFLEET_RENDERER_URL
let client: ChildProcess | undefined
let exited: Promise<void> | undefined
let socket: WebSocket | undefined
let diagnostics = ""
let nextId = 0

function launch(args: string[]): void {
  const child = spawn(executable, [appPath, ...args], {
    env, stdio: ["ignore", "ignore", "pipe"],
  })
  client = child
  exited = new Promise(resolveExit => { child.once("exit", () => resolveExit()); child.once("error", () => resolveExit()) })
  child.stderr!.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
}

async function stop(): Promise<void> {
  socket?.close()
  if (!client || client.exitCode !== null || client.signalCode !== null) return
  client.kill("SIGTERM")
  const timer = setTimeout(() => client?.kill("SIGKILL"), 5_000)
  try { await exited } finally { clearTimeout(timer) }
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (client?.exitCode !== null || client?.signalCode !== null || diagnostics.includes("App threw an error during load")) {
      throw new Error("Production Electron entry failed to start")
    }
    const value = await read()
    if (value !== undefined) return value
    await delay(50)
  }
  throw new Error("Production Electron startup timed out")
}

async function evaluate<T>(expression: string): Promise<T> {
  const id = ++nextId
  return new Promise<T>((resolveResult, reject) => {
    const timer = setTimeout(() => finish(new Error("Renderer evaluation timed out")), 5_000)
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer)
      socket!.removeEventListener("message", receive)
      if (error) reject(error)
      else resolveResult(value!)
    }
    const receive = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      if (message.error || message.result?.exceptionDetails) finish(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
      else finish(undefined, message.result.result.value as T)
    }
    socket!.addEventListener("message", receive)
    socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

/** The app hosts the daemon in its own process and stops it when it quits. */
async function probeHostedDaemon(): Promise<void> {
  const hostProfile = join(directory, "host-profile")
  await mkdir(hostProfile)
  await writeFile(join(hostProfile, "settings.json"), JSON.stringify({ localAgentEnabled: true }))
  launch([`--user-data-dir=${hostProfile}`])
  const control = await until(async () => {
    try { return await DaemonClient.connect(() => {}, () => {}, daemonDirectory) }
    catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ECONNREFUSED"].includes(String(error.code))) return undefined
      throw error
    }
  })
  const peer = await createPeer()
  try {
    const status = await control.call("centralStatus", {})
    assert.equal(status.configured, false)
    assert.ok(status.identity.originId && status.identity.machineId)
    await peer.createDataChannel("deskfleet-acp")
    await assert.rejects(control.call("agentOffer", { sessionId: "unauthorized-agent", sdp: await peer.createOffer() }), /central|backend|authorized/iu)
    await assert.rejects(control.call("catalogList", {}), /central|backend|authorized/iu)
  } finally {
    await peer.close()
    control.close()
  }
  client!.kill("SIGTERM")
  const timer = setTimeout(() => client?.kill("SIGKILL"), 15_000)
  try { await exited } finally { clearTimeout(timer) }
  assert.equal(client!.exitCode, 0, "Quitting the app must finish its daemon's shutdown")
  await assert.rejects(stat(join(daemonDirectory, "daemon.json")), { code: "ENOENT" })
}

try {
  await stat(join(appPath, "out/main/index.js"))
  await mkdir(profile)
  await writeFile(join(profile, "settings.json"), JSON.stringify({ localAgentEnabled: false }))
  launch([`--user-data-dir=${profile}`, "--remote-debugging-port=0"])
  const port = await until(async () => {
    const contents = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
    return contents ? Number(contents.split("\n")[0]) : undefined
  })
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await response.json() as { type: string; url: string; webSocketDebuggerUrl: string }[]
    return targets.find(value => value.type === "page" && value.url.startsWith("deskfleet-app://bundle/index.html"))
  })
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolveOpen, reject) => {
    socket!.addEventListener("open", () => resolveOpen(), { once: true })
    socket!.addEventListener("error", () => reject(new Error("Could not inspect the production renderer")), { once: true })
  })
  await until(async () => await evaluate<boolean>("document.readyState === 'complete' && !!document.querySelector('#root input[type=url]') && !!window.deskfleet?.central") ? true : undefined)
  assert.deepEqual(await evaluate("window.deskfleet.settings.get()"), { enabled: false, status: "stopped" })
  await assert.rejects(stat(join(daemonDirectory, "daemon.json")), { code: "ENOENT" })
  await stop()

  const version = await promisify(execFile)(executable, [join(appPath, "out/main/index.js"), "--codex-acp", "--version"], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000,
  })
  assert.match(version.stdout, /\b2\.2\.2\b/u)
  const claudeVersion = await promisify(execFile)(executable, [join(appPath, "out/main/index.js"), "--claude-agent-acp", "--version"], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000,
  })
  assert.equal(claudeVersion.stdout.trim(), "0.94.0")
  await probeHostedDaemon()
  console.log("Electron startup smoke passed: account UI, Codex and Claude Code adapters, hosted daemon identity, and authenticated management boundary")
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
