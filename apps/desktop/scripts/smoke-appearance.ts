import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative, resolve } from "node:path"
import { build } from "esbuild"
import type { AppearanceSmokeContext, AppearanceSmokeResult } from "./fixtures/appearance-main.ts"

const outputDirectory = resolve(import.meta.dirname, "../../../target/appearance-smoke")
await mkdir(outputDirectory, { recursive: true })
const directory = await realpath(await mkdtemp(join(outputDirectory, "runtime-")))
const executable = createRequire(import.meta.url)("electron") as string
const profileDirectory = join(directory, "profile")
const rendererDirectory = resolve(import.meta.dirname, "../out/renderer")
const preloadPath = join(directory, "preload.cjs")
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

async function launch(phase: AppearanceSmokeContext["phase"]): Promise<AppearanceSmokeResult> {
  const context: AppearanceSmokeContext = { phase, rendererDirectory, preloadPath, profileDirectory, outputDirectory }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${profileDirectory}`, `--appearance-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const client = electron
  exited = new Promise(resolveExit => { client.once("exit", () => resolveExit()); client.once("error", () => resolveExit()) })
  client.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  try {
    return await new Promise<AppearanceSmokeResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error(`Electron appearance ${phase} smoke timed out`)), 60_000)
      const fail = (reason: unknown) => { clearTimeout(timer); rejectResult(reason) }
      client.once("error", fail)
      client.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
      client.on("message", (message: { result?: AppearanceSmokeResult; error?: string }) => {
        if (message.error) fail(new Error(message.error))
        if (message.result) { clearTimeout(timer); resolveResult(message.result) }
      })
    })
  } finally { await stopClient() }
}

try {
  await stat(join(rendererDirectory, "index.html"))
  await mkdir(profileDirectory)
  // A damaged profile must still let the user edit Appearance and repair it through a normal save.
  await writeFile(join(profileDirectory, "appearance.json"), '{"theme":')
  await Promise.all([
    build({ entryPoints: [join(import.meta.dirname, "fixtures/appearance-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" }),
    build({ entryPoints: [join(import.meta.dirname, "fixtures/appearance-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" }),
  ])
  const changed = await launch("change")
  const saved = JSON.parse(await readFile(join(profileDirectory, "appearance.json"), "utf8"))
  assert.deepEqual(saved, changed.settings)
  const restored = await launch("restore")
  assert.deepEqual(restored.settings, changed.settings)
  const results = { changed, restored }
  await writeFile(join(outputDirectory, "results.json"), JSON.stringify(results, null, 2) + "\n")
  console.log("Production Electron Appearance: corrupt profile recovery, theme thumbnails, language, native theme, CSS fonts, live xterm font/ligature preview, restart persistence, and minimum window layout passed", results)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stopClient()
  // Only the fresh smoke runtime is disposable; screenshots remain beside it.
  assert.match(relative(await realpath(outputDirectory), directory), /^runtime-[^\\/]+$/)
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
