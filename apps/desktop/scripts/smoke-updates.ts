import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative, resolve } from "node:path"
import { build } from "esbuild"
import type { UpdateSmokeContext, UpdateSmokeResult } from "./fixtures/update-main.ts"

const outputDirectory = resolve(import.meta.dirname, "../../../target/updates-smoke")
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

try {
  await stat(join(rendererDirectory, "index.html"))
  await mkdir(profileDirectory)
  await Promise.all([
    build({ entryPoints: [join(import.meta.dirname, "fixtures/update-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" }),
    build({ entryPoints: [join(import.meta.dirname, "fixtures/update-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron", "electron-updater"], target: "node24" }),
  ])
  const context: UpdateSmokeContext = { rendererDirectory, preloadPath, profileDirectory, outputDirectory }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${profileDirectory}`, `--updates-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const client = electron
  exited = new Promise(resolveExit => { client.once("exit", () => resolveExit()); client.once("error", () => resolveExit()) })
  client.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  const result = await new Promise<UpdateSmokeResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error("Electron updates smoke timed out")), 90_000)
    const fail = (reason: unknown) => { clearTimeout(timer); rejectResult(reason) }
    client.once("error", fail)
    client.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
    client.on("message", (message: { result?: UpdateSmokeResult; error?: string }) => {
      if (message.error) fail(new Error(message.error))
      if (message.result) { clearTimeout(timer); resolveResult(message.result) }
    })
  })
  assert.equal(result.downloads, 2)
  assert.equal(result.installs, 1)
  assert.equal(result.shutdowns, 1)
  await writeFile(join(outputDirectory, "results.json"), JSON.stringify(result, null, 2) + "\n")
  console.log("Production Electron update UI: explicit download consent, retry, progress, shutdown before install, account sidebar, translations and minimum width passed", result)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stopClient()
  assert.match(relative(await realpath(outputDirectory), directory), /^runtime-[^\\/]+$/)
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
