import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { DaemonClient } from "../../daemon/src/control-client.ts"
import { DAEMON_HOST_ARGUMENT } from "../src/shared/daemon-launch.ts"

// Requires an installed, authenticated Codex CLI. Exercise the actual Vite
// bundle and its ACP subprocess; source imports or a fake provider miss URL
// rewriting and Electron child-process startup failures.
const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-agent-configuration-")))
const executable = createRequire(import.meta.url)("electron") as string
const appPath = resolve(import.meta.dirname, "..")
const daemonDirectory = join(directory, "daemon")
const checkoutPath = join(directory, "checkout")
let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let client: DaemonClient | undefined
let launchError: Error | undefined
let diagnostics = ""

async function connect(): Promise<DaemonClient> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (launchError) throw launchError
    if (electron!.exitCode !== null || electron!.signalCode !== null) {
      throw new Error(`Electron daemon exited before discovery (${electron!.signalCode ?? electron!.exitCode})`)
    }
    try { return await DaemonClient.connect(() => {}, () => {}, daemonDirectory) }
    catch (error) {
      if (Date.now() >= deadline) throw new Error("Production Electron daemon startup timed out", { cause: error })
      await delay(50)
    }
  }
}

try {
  await stat(join(appPath, "out/main/index.js"))
  await mkdir(checkoutPath)
  const env: NodeJS.ProcessEnv = { ...process.env, DESKFLEET_DAEMON_DIRECTORY: daemonDirectory }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DESKFLEET_RENDERER_URL
  electron = spawn(executable, [appPath, DAEMON_HOST_ARGUMENT], {
    cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
  })
  exited = new Promise(resolveExit => {
    electron!.once("exit", () => resolveExit())
    electron!.once("error", error => { launchError = error; resolveExit() })
  })
  for (const stream of [electron.stdout, electron.stderr]) {
    stream?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  }
  client = await connect()
  const workspace = await client.call("workspaceCreate", { name: "Agent configuration smoke", directories: [{ path: checkoutPath }] })
  const worktreeId = workspace.worktrees[0]!.id
  const initial = await client.call("agentConfiguration", { provider: "codex", worktreeId })
  assert.equal(initial.provider.id, "codex")
  const models = initial.models
  assert.ok(models, "Codex must expose a model configuration")
  assert.ok(models.options.some(model => model.id === models.currentValue), "Codex must return its current model")
  const model = models.options.find(option => option.id !== models.currentValue)
  assert.ok(model, "The installed Codex must offer a second model to exercise model switching")
  const changed = await client.call("agentConfiguration", { provider: "codex", worktreeId, model: model.id })
  assert.equal(changed.models?.currentValue, model.id, "The bundled ACP host must apply the chosen model")
  const effort = changed.reasoningEfforts?.options.find(option => option.id !== changed.reasoningEfforts!.currentValue)
  assert.ok(effort, "The chosen Codex model must offer another reasoning effort")
  const configured = await client.call("agentConfiguration", { provider: "codex", worktreeId, model: model.id, reasoningEffort: effort.id })
  assert.equal(configured.models?.currentValue, model.id)
  assert.equal(configured.reasoningEfforts?.currentValue, effort.id, "The bundled ACP host must apply the chosen reasoning effort")
  assert.equal((await client.call("catalogList", {})).workspaces[0]?.worktrees.length, 1, "Model discovery must not allocate a session worktree")
  console.log("Production Electron Agent configuration: dynamic model discovery, model switching, and reasoning effort switching passed", { model: model.id, reasoningEffort: effort.id })
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  try { await client?.call("shutdown", {}) }
  finally {
    client?.close()
    if (electron && electron.exitCode === null && electron.signalCode === null) {
      const timeout = setTimeout(() => electron!.kill("SIGKILL"), 15_000)
      await exited
      clearTimeout(timeout)
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
