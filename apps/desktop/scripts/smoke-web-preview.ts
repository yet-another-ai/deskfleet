import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type RequestListener, type Server } from "node:http"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { nodeBuiltins } from "../build/node-builtins.ts"
import type { WebPreviewSmokeContext, WebPreviewSmokeResult } from "./fixtures/web-preview-main.ts"

const outputDirectory = resolve(import.meta.dirname, "../../../target/web-preview-smoke")
await mkdir(outputDirectory, { recursive: true })
const directory = await realpath(await mkdtemp(join(outputDirectory, "runtime-")))
const executable = createRequire(import.meta.url)("electron") as string
const profileDirectory = join(directory, "profile")
const preloadPath = join(directory, "preload.cjs")

let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let diagnostics = ""
let ungrantedHits = 0

async function startHttpServer(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  if (electron.connected) electron.send({ close: true })
  const timer = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited
  clearTimeout(timer)
}

const allowedServer = await startHttpServer((req, res) => {
  if (req.url === "/next") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end("<!doctype html><html><head><title>Preview Next</title></head><body>next</body></html>")
    return
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  })
  res.end('<!doctype html><html><head><title>Preview Home</title></head><body><h1 id="status">ok</h1></body></html>')
})

const ungrantedServer = await startHttpServer((_req, res) => {
  ungrantedHits++
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end("<!doctype html><html><head><title>Secret</title></head><body>blocked</body></html>")
})

try {
  await mkdir(profileDirectory)
  await Promise.all([
    build({ entryPoints: [join(import.meta.dirname, "fixtures/web-preview-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron", ...nodeBuiltins], target: "node24" }),
    build({ entryPoints: [join(import.meta.dirname, "fixtures/web-preview-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron", ...nodeBuiltins], banner: { js: 'import { createRequire as __smokeCreateRequire } from "node:module"; const require = __smokeCreateRequire(import.meta.url);' }, target: "node24" }),
  ])

  const context: WebPreviewSmokeContext = {
    preloadPath,
    allowedOrigin: allowedServer.origin,
    ungrantedOrigin: ungrantedServer.origin,
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${profileDirectory}`, `--web-preview-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."),
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const client = electron
  exited = new Promise(resolveExit => { client.once("exit", () => resolveExit()); client.once("error", () => resolveExit()) })
  client.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })

  const result = await new Promise<WebPreviewSmokeResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error("Electron web preview smoke timed out")), 45_000)
    const fail = (reason: unknown) => { clearTimeout(timer); rejectResult(reason) }
    client.once("error", fail)
    client.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
    client.on("message", (message: { result?: WebPreviewSmokeResult; error?: string }) => {
      if (message.error) fail(new Error(message.error))
      if (message.result) { clearTimeout(timer); resolveResult(message.result) }
    })
  })

  assert.equal(ungrantedHits, 0, "Ungranted loopback origin must never receive HTTP requests")
  console.log("Electron web preview smoke passed", result)
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  await stopClient()
  allowedServer.server.close()
  ungrantedServer.server.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
