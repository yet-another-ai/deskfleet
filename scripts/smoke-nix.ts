import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

// Run with a plain Node runtime; every application probe uses the installed
// package, without workspace node_modules or a separately built native addon.
const [output, option, ...extra] = process.argv.slice(2)
assert.ok(output && (!option || option === "--gui") && extra.length === 0,
  "Usage: node scripts/smoke-nix.ts <package-output> [--gui]")
assert.equal(process.platform, "linux", "The Nix package smoke supports Linux")
const packagePath = await realpath(output)
const executable = join(packagePath, "bin", "deskfleet")
const resources = join(packagePath, "lib", "deskfleet", "resources")
const entry = join(resources, "app.asar", "out", "main", "index.js")
const addon = join(resources, "app.asar.unpacked", "out", "main", "deskfleet.node")
const manifest = JSON.parse(await readFile(new URL("../apps/daemon/package.json", import.meta.url), "utf8")) as {
  version: string
  dependencies: Record<string, string>
}
const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-nix-smoke-")))
const profile = join(directory, "profile")
const configHome = join(directory, "config")
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: configHome,
  XDG_CACHE_HOME: join(directory, "cache"),
  XDG_DATA_HOME: join(directory, "data"),
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ASAR
delete env.NODE_OPTIONS
delete env.DESKFLEET_RENDERER_URL
delete env.DESKFLEET_LAUNCHER
delete env.APPIMAGE
let client: ChildProcess | undefined
let exited: Promise<void> | undefined
let launchError: Error | undefined
let socket: WebSocket | undefined
let diagnostics = ""
let nextId = 0

async function node(args: string[]): Promise<string> {
  const result = await promisify(execFile)(executable, args, {
    cwd: directory, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000,
  })
  return result.stdout.trim()
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (client && (client.exitCode !== null || client.signalCode !== null)) {
      throw new Error(`Installed Electron exited during startup (${client.exitCode ?? client.signalCode})`)
    }
    const value = await read()
    if (value !== undefined) return value
    await delay(50)
  }
  throw new Error("Installed Electron startup timed out")
}

async function evaluate<T>(expression: string): Promise<T> {
  const connection = socket!
  const id = ++nextId
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Installed renderer evaluation timed out")), 10_000)
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer)
      connection.removeEventListener("message", receive)
      if (error) reject(error)
      else resolve(value!)
    }
    const receive = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      if (message.error || message.result?.exceptionDetails) {
        finish(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
      } else finish(undefined, message.result.result.value as T)
    }
    connection.addEventListener("message", receive)
    connection.send(JSON.stringify({
      id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true },
    }))
  })
}

async function stop(): Promise<void> {
  socket?.close()
  socket = undefined
  if (!client || client.exitCode !== null || client.signalCode !== null) return
  const child = client
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try { child.kill("SIGTERM"); await exited } finally { clearTimeout(timer) }
}

async function gui(): Promise<void> {
  assert.ok(env.DISPLAY, "--gui needs an X11 display; use xvfb-run -a")
  await mkdir(profile)
  client = spawn(executable, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--ozone-platform=x11",
    // The welcome screen needs no remote account. Suppress renderer telemetry
    // and other Chromium network requests while inspecting local package behavior.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
  ], {
    cwd: directory,
    env: { ...env, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined },
    stdio: ["ignore", "ignore", "pipe"],
  })
  exited = new Promise(resolve => {
    client!.once("exit", () => resolve())
    client!.once("error", error => { launchError = error; resolve() })
  })
  client.stderr!.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  const port = await until(async () => {
    const contents = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
    return contents ? Number(contents.split("\n")[0]) : undefined
  })
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
    const targets = await response.json() as { type: string; url: string; webSocketDebuggerUrl: string }[]
    return targets.find(value => value.type === "page" && value.url.startsWith("deskfleet-app://bundle/index.html"))
  })
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed renderer connection timed out")), 5_000)
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not inspect installed renderer")) }, { once: true })
  })
  await until(async () => await evaluate<boolean>(
    "document.readyState === 'complete' && !!document.querySelector('#root h1') && !!window.deskfleet?.onboarding",
  ) ? true : undefined)
  assert.equal((await evaluate<{ status: string }>("window.deskfleet.settings.get()")).status, "running")
  assert.equal((await evaluate<{ status: string }>("window.deskfleet.updates.get()")).status, "disabled")
  await stat(join(profile, "daemon", "daemon.json"))
  const enrollment = await evaluate<{ ok: boolean; value: { configured: boolean; identity: { machineId: string } } }>(
    "window.deskfleet.centralBridge.invoke('localEnrollment', [])",
  )
  assert.equal(enrollment.ok, true)
  assert.equal(enrollment.value.configured, false)
  assert.ok(enrollment.value.identity.machineId)
  assert.deepEqual(await evaluate("window.deskfleet.settings.setLaunchAtStartup(true)"), { available: true, enabled: true })
  const startup = join(configHome, "autostart", "io.github.yet_another_ai.deskfleet.desktop")
  assert.ok((await readFile(startup, "utf8")).includes(`Exec="${executable}"`), "Autostart must use the installed Nix wrapper")
  assert.deepEqual(await evaluate("window.deskfleet.settings.setLaunchAtStartup(false)"), { available: true, enabled: false })
  await assert.rejects(stat(startup), { code: "ENOENT" })
  await stop()
  assert.equal(client.exitCode, 0, "The packaged app must shut down its hosted daemon cleanly")
  await assert.rejects(stat(join(profile, "daemon", "daemon.json")), { code: "ENOENT" })
}

try {
  await stat(executable)
  await stat(addon)
  const info = JSON.parse(await node(["-e", `
    const addon = { exports: {} };
    process.dlopen(addon, process.argv[1]);
    (async () => {
      const terminal = await addon.exports.createTerminal({
        cwd: process.cwd(), cols: 80, rows: 24,
        command: "/bin/sh", args: ["-c", "printf deskfleet-nix-pty"],
      });
      let output = "", exitCode;
      try {
        for (;;) {
          const event = await terminal.nextEvent();
          if (!event) break;
          if (event.kind === "data") output += event.data.toString();
          if (event.kind === "error") throw new Error(event.error);
          if (event.kind === "exit") { exitCode = event.exitCode; break; }
        }
      } finally { await terminal.close(); }
      process.stdout.write(JSON.stringify({
        native: addon.exports.nativeInfo(), launcher: process.env.DESKFLEET_LAUNCHER,
        terminal: { output, exitCode },
      }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, addon])) as {
    native: { version: string; os: string; arch: string }; launcher: string
    terminal: { output: string; exitCode: number }
  }
  assert.deepEqual(info.native, {
    version: manifest.version, os: "linux", arch: process.arch === "arm64" ? "aarch64" : "x86_64",
  })
  assert.equal(info.launcher, executable, "The Nix wrapper must preserve its launcher for autostart")
  assert.deepEqual(info.terminal, { output: "deskfleet-nix-pty", exitCode: 0 })
  for (const [argument, dependency, prefix] of [
    ["--codex-acp", "@agentclientprotocol/codex-acp", "@agentclientprotocol/codex-acp "],
    ["--claude-agent-acp", "@agentclientprotocol/claude-agent-acp", ""],
    ["--pi-acp", "pi-acp", ""],
  ]) {
    assert.equal(await node([entry, argument, "--version"]), `${prefix}${manifest.dependencies[dependency]}`)
  }
  if (option === "--gui") await gui()
  console.log(`Nix package smoke passed: native addon, PTY command, and bundled ACP adapters${option === "--gui" ? ", packaged renderer, hosted daemon, autostart wrapper, and disabled updater" : ""}`)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
