import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { startDaemon } from "../../daemon/src/daemon.ts"
import type { CatalogSmokeContext, CatalogSmokeResult } from "./fixtures/catalog-main.ts"

const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-catalog-smoke-")))
const executable = createRequire(import.meta.url)("electron") as string
const controlDirectory = join(directory, "daemon")
const rendererDirectory = resolve(import.meta.dirname, "../out/renderer")
const preloadPath = join(directory, "local-preload.cjs")
const checkoutPath = join(directory, "checkout")
const initialPath = join(directory, "initial-checkout")
const updatedPath = join(directory, "updated-checkout")
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let diagnostics = ""
let clientNumber = 0

function ancestors(path: string): string[] {
  const paths = [path]
  while (dirname(paths[0]!) !== paths[0]) paths.unshift(dirname(paths[0]!))
  return paths
}

async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  if (electron.connected) electron.send({ close: true })
  const timer = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited
  clearTimeout(timer)
}

async function launchClient(phase: CatalogSmokeContext["phase"], previous?: CatalogSmokeResult): Promise<CatalogSmokeResult> {
  const context: CatalogSmokeContext = {
    phase, rendererDirectory, preloadPath, checkoutPath, initialPath, updatedPath,
    checkoutAncestors: ancestors(checkoutPath),
    initialAncestors: ancestors(initialPath),
    updatedAncestors: ancestors(updatedPath),
    ...previous,
  }
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${join(directory, `profile-${++clientNumber}`)}`, `--catalog-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, DESKFLEET_DAEMON_DIRECTORY: controlDirectory },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  exited = new Promise(resolveExit => { electron!.once("exit", () => resolveExit()); electron!.once("error", () => resolveExit()) })
  electron.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  try {
    return await new Promise<CatalogSmokeResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error("Electron catalog smoke timed out")), 45_000)
      const fail = (error: unknown) => { clearTimeout(timer); rejectResult(error) }
      electron!.once("error", fail)
      electron!.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
      electron!.on("message", (message: { result?: CatalogSmokeResult; error?: string }) => {
        if (message.error) fail(new Error(message.error))
        if (message.result) { clearTimeout(timer); resolveResult(message.result) }
      })
    })
  } finally {
    await stopClient()
  }
}

async function verifyShellDirectory(terminalId: string): Promise<void> {
  assert.equal(daemon!.terminals.list().length, 1)
  assert.equal(daemon!.terminals.snapshot(terminalId).summary.cwd, updatedPath)
  const command = process.platform === "win32"
    ? "@echo off\rfor %I in (.) do @echo DF_CWD:%~fI\r"
    : "printf 'DF_%s:%s\\n' CWD \"$(pwd -P)\"\r"
  await daemon!.terminals.input(terminalId, Buffer.from(command))
  const deadline = Date.now() + 10_000
  let output = ""
  while (Date.now() < deadline) {
    const end = daemon!.terminals.snapshot(terminalId).end
    output = (await daemon!.terminals.read(terminalId, Math.max(0, end - 65_536), 65_536)).toString("utf8")
    if (output.includes(`DF_CWD:${updatedPath}`)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`The real shell did not report the selected directory: ${output.slice(-2_000)}`)
}

try {
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/local-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" })
  await Promise.all([stat(join(rendererDirectory, "index.html")), stat(preloadPath)])
  await Promise.all([mkdir(checkoutPath), mkdir(initialPath), mkdir(updatedPath)])
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/catalog-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" })
  daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const created = await launchClient("create")
  assert.ok(created.terminalId)
  await verifyShellDirectory(created.terminalId)
  await daemon.terminals.hangup(created.terminalId)
  const restored = await launchClient("restore", created)
  assert.equal(restored.restored, true)
  console.log("Production Electron catalog: folder picker creation and editing, automatic main worktree, default directory order and shell cwd, persistence, and deletion passed", restored)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stopClient()
  await daemon?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
