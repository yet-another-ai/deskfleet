import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import ts from "typescript"
import { rendererContentSecurityPolicy } from "../src/shared/renderer-csp.ts"

// The default fixture needs no capture permission. DESKFLEET_SMOKE_CAPTURE=1
// streams a real display into the hidden test window without saving a recording.
// DESKFLEET_SMOKE_HARDWARE=1 encodes generated red pixels using Linux hardware;
// DESKFLEET_SMOKE_CODEC selects h264 (default), h265 or av1 for that mode.
// Recreate the 663-byte red-frame fixture with FFmpeg if changing its dimensions or profile:
// ffmpeg -f lavfi -i color=c=red:s=64x64:r=10 -frames:v 1 -c:v libx264 \
//   -profile:v baseline -level 3.1 -pix_fmt yuv420p \
//   -x264-params keyint=1:min-keyint=1:scenecut=0 -f h264 red-64x64.h264
const root = resolve(import.meta.dirname, "../../..")
const capture = process.env.DESKFLEET_SMOKE_CAPTURE === "1"
const hardware = process.env.DESKFLEET_SMOKE_HARDWARE === "1"
const codec = process.env.DESKFLEET_SMOKE_CODEC ?? "h264"
assert.ok(["h264", "h265", "av1"].includes(codec), "DESKFLEET_SMOKE_CODEC must be h264, h265 or av1")
assert.ok(!hardware || process.platform === "linux", "generated hardware smoke requires Linux")
assert.ok(!(capture && hardware), "select either capture or generated hardware smoke")
assert.ok(hardware || codec === "h264", "codec selection requires generated hardware smoke")
const source = capture ? "desktop" : hardware ? "hardware" : "fixture"
const waylandCapture = capture && process.platform === "linux"
const executable = createRequire(import.meta.url)("electron") as string
const nativeExecutable = join(root, "target/debug/examples", process.platform === "win32" ? "media_smoke.exe" : "media_smoke")
const directory = await mkdtemp(join(tmpdir(), "deskfleet-media-smoke-"))
const fixtures = join(import.meta.dirname, "fixtures")
const children: ChildProcess[] = []
const exits = new Map<ChildProcess, Promise<void>>()
let diagnostics = ""

function track(child: ChildProcess): void {
  children.push(child)
  exits.set(child, new Promise(resolveExit => {
    child.once("exit", () => resolveExit())
    child.once("error", () => resolveExit())
  }))
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { diagnostics += chunk })
}

try {
  for (const [source, output, module] of [
    ["media-main.ts", "main.cjs", ts.ModuleKind.CommonJS],
    ["media-preload.ts", "preload.cjs", ts.ModuleKind.CommonJS],
    ["media-renderer.ts", "renderer.js", ts.ModuleKind.ESNext],
  ] as const) {
    const code = await readFile(join(fixtures, source), "utf8")
    await writeFile(join(directory, output), ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module },
    }).outputText)
  }
  await writeFile(join(directory, "index.html"), `<!doctype html><html data-source="${source}" data-codec="${codec}" data-consent-timeout="${waylandCapture ? "120000" : "20000"}">
<meta http-equiv="Content-Security-Policy" content="${rendererContentSecurityPolicy(true)}">
<video autoplay muted playsinline></video><script type="module" src="/renderer.js"></script></html>`)
  const native = spawn(nativeExecutable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(waylandCapture ? { DESKFLEET_SMOKE_PORTAL_DIRECTORY: join(directory, "portal") } : {}),
    },
  })
  track(native)
  const electron = spawn(executable, [join(directory, "main.cjs"), `--user-data-dir=${join(directory, "profile")}`], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  track(electron)
  const lines = createInterface({ input: native.stdout })
  const result = await new Promise<Record<string, unknown>>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error("Electron media smoke timed out")), waylandCapture ? 120_000 : 30_000)
    const fail = (error: unknown) => { clearTimeout(timer); rejectResult(error) }
    for (const child of children) {
      child.once("error", fail)
      child.once("exit", code => fail(new Error(`Media smoke child exited early (${code})`)))
    }
    native.stdin.on("error", fail)
    electron.on("message", (message: { kind: string; result?: Record<string, unknown>; error?: string }) => {
      if (message.kind === "complete" && message.result) {
        clearTimeout(timer)
        resolveResult(message.result)
      } else if (message.kind === "error") fail(new Error(message.error))
      else native.stdin.write(`${JSON.stringify(message)}\n`)
    })
    lines.on("line", line => {
      try {
        const message = JSON.parse(line) as { kind: string }
        if (message.kind !== "ready" && electron.connected) electron.send(message, error => {
          if (error) fail(error)
        })
      } catch (error) { fail(error) }
    })
  }).finally(() => lines.close())
  assert.equal(result.source, source)
  assert.equal(result.codec, codec)
  if (result.skipped) {
    assert.ok(hardware && typeof result.reason === "string", "only unsupported hardware-smoke browser codecs may skip")
    console.log(`SKIP Electron/native hardware ${codec}: ${result.reason}`)
  } else {
    assert.equal(result.connection, "connected")
    assert.equal(result.dataChannel, true)
    if (capture) {
      assert.ok(typeof result.framesDecoded === "number" && result.framesDecoded >= 1)
      assert.ok(typeof result.width === "number" && result.width > 0)
      assert.ok(typeof result.height === "number" && result.height > 0)
      console.log("Electron/native WebRTC: real desktop H.264 decode, video srcObject, trickle ICE, and DataChannel echo passed", result)
    } else if (hardware) {
      assert.equal(result.width, 320)
      assert.equal(result.height, 240)
      assert.ok(typeof result.framesDecoded === "number" && result.framesDecoded >= 3)
      console.log(`Electron/native WebRTC: generated hardware ${codec} encode/decode, red pixel validation, video srcObject, trickle ICE, and DataChannel echo passed`, result)
    } else {
      assert.equal(result.width, 64)
      assert.equal(result.height, 64)
      console.log("Electron/native WebRTC: H.264 decode, Opus reception, video srcObject, trickle ICE, and DataChannel echo passed", result)
    }
  }
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (child.connected) child.send({ kind: "close" })
    else child.stdin?.end(`${JSON.stringify({ kind: "close" })}\n`)
    const timer = setTimeout(() => child.kill("SIGKILL"), capture || hardware ? 8_000 : 3_000)
    await exits.get(child)
    clearTimeout(timer)
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
