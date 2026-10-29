import { ImageAddon } from "@xterm/addon-image"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { decodeTerminalBytes, TerminalClient } from "../../../../packages/components/src/services/terminal-client.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"

const { deskfleet, terminalSmoke } = window as unknown as {
  deskfleet: DeskfleetDesktopApi
  terminalSmoke: { context: { phase?: string; terminalId?: string; secondId?: string; pid?: string; imagePath?: string }; finish(result: unknown): void }
}
const terminal = new Terminal({ cols: 100, rows: 32, scrollback: 5_000 })
terminal.open(document.getElementById("terminal")!)
const images = new ImageAddon({ enableSizeReports: true, pixelLimit: 16_777_216, storageLimit: 64 })
terminal.loadAddon(images)
let client: TerminalClient
let output = ""
let exitCode: number | undefined
let ready = false
const decoder = new TextDecoder()

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function verifyImage(): Promise<void> {
  // Output arrives before xterm finishes parsing it, including asynchronous image decoding.
  await new Promise<void>(resolve => terminal.write("", resolve))
  const buffer = terminal.buffer.active
  for (let y = buffer.length - 1; y >= 0; y--) {
    for (let x = 0; x < terminal.cols; x++) {
      const image = images.getImageAtBufferCell(x, y)
      if (!image) continue
      require(image.width === 768 && image.height === 512, `Unexpected image dimensions: ${image.width}×${image.height}`)
      const pixel = image.getContext("2d")!.getImageData(0, 0, 1, 1).data
      require(pixel.join(",") === "255,0,0,255", `Unexpected image pixel: ${pixel}`)
      return
    }
  }
  throw new Error("icat output did not produce a terminal image")
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Terminal smoke condition timed out; output: ${output.slice(-2_000)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function newClient(): TerminalClient {
  return new TerminalClient({
    ...deskfleet.terminal,
    offer: async (offer) => {
      require(!/^m=(audio|video) /m.test(offer.sdp), "Terminal offer contains media tracks")
      const answer = await deskfleet.terminal.offer(offer)
      require(!/^m=(audio|video) /m.test(answer.sdp), "Terminal answer contains media tracks")
      return answer
    },
  })
}

function subscribe(id: string): void {
  client.subscribe(id, (event, ack) => {
    if (event.kind === "reset") { terminal.reset(); output = ""; decoder.decode() }
    if (event.kind === "output") {
      const bytes = decodeTerminalBytes(event.data)
      output += decoder.decode(bytes, { stream: true })
      terminal.write(bytes, ack)
    }
    if (event.kind === "exit") exitCode = event.exitCode
    if (event.kind === "ready") ready = true
    if (event.kind === "error") terminalSmoke.finish({ error: event.error })
  })
}

async function attach(id: string): Promise<void> {
  ready = false
  await deskfleet.terminal.dial({ mode: "resume", terminalId: id })
  subscribe(id)
  await client.call("attach", { sessionId: id })
  await until(() => ready)
}

async function writeHistory(): Promise<void> {
  client = newClient()
  const summary = await deskfleet.terminal.dial({ mode: "create", terminalId: crypto.randomUUID(), cols: 100, rows: 32 })
  const second = await deskfleet.terminal.dial({ mode: "create", terminalId: crypto.randomUUID(), cols: 100, rows: 32 })
  await attach(summary.id)
  const windows = deskfleet.platform === "win32"
  // Disable PTY echo on Unix so matching output cannot succeed on echoed input.
  await client.input(summary.id, windows
    ? "@echo off\rchcp 65001 >nul\rset DF_SMOKE_TOKEN=%RANDOM%\recho DF_READY:%DF_SMOKE_TOKEN%\r"
    : "stty -echo; printf '\\nDF_%s:%s\\n' READY $$\r")
  await until(() => /DF_READY:\d+/.test(output))
  const pid = /DF_READY:(\d+)/.exec(output)![1]!
  terminal.resize(91, 37)
  await client.call("resize", { sessionId: summary.id, cols: 91, rows: 37 })
  await client.input(summary.id, windows
    ? "echo DF_UNICODE:终端\rpwsh -Command \"Write-Output ('DF_' + 'SIZE:' + [Console]::WindowWidth + ':' + [Console]::WindowHeight)\"\r"
    : "printf 'DF_%s:终端\\n' UNICODE; printf DF_SIZE:; stty size\r")
  await until(() => output.includes("DF_UNICODE:终端") && output.includes(windows ? "DF_SIZE:91:37" : "DF_SIZE:37 91"))
  await client.input(summary.id, windows
    ? "pwsh -Command \"Write-Output ('x' * 300000); Write-Output ('DF_' + 'HISTORY_END')\"\r"
    : "head -c 300000 /dev/zero | tr '\\0' x; printf '\\nDF_%s\\n' HISTORY_END\r")
  await until(() => output.includes("DF_HISTORY_END"))
  const imagePath = terminalSmoke.context.imagePath
  require(imagePath, "Missing icat fixture path")
  const quotedImage = windows ? `"${imagePath}"` : `'${imagePath.replaceAll("'", "'\\''")}'`
  await client.input(summary.id, windows
    ? `icat ${quotedImage} && echo DF_IMAGE_END\r`
    : `icat ${quotedImage} && printf '\\nDF_%s\\n' IMAGE_END\r`)
  await until(() => output.includes("DF_IMAGE_END"))
  await verifyImage()
  require(output.includes("DF_UNICODE:终端"), "Full output before client change was lost")
  client.close()
  terminalSmoke.finish({ result: { phase: "write", dataOnly: true, terminalId: summary.id, secondId: second.id, pid } })
}

async function restoreHistory(): Promise<void> {
  const { terminalId, secondId, pid } = terminalSmoke.context
  require(terminalId && secondId && pid, "Missing resume context")
  client = newClient()
  const sessions = await deskfleet.terminal.list()
  require(sessions.length === 2 && sessions.some(session => session.id === terminalId), "A new client did not discover both shells")
  const restored = sessions.find(session => session.id === terminalId)!
  terminal.resize(restored.cols, restored.rows)
  await attach(terminalId)
  require(output.length > 300_000 && output.includes(`DF_READY:${pid}`) && output.includes("DF_UNICODE:终端") && output.includes("DF_HISTORY_END"), "Full history was not restored on a fresh client")
  require(output.includes("DF_IMAGE_END"), "Image output was not restored on a fresh client")
  await verifyImage()
  const replayedBytes = new TextEncoder().encode(output).byteLength
  await client.input(terminalId, deskfleet.platform === "win32"
    ? "echo DF_REATTACHED:%DF_SMOKE_TOKEN%\r"
    : "printf 'DF_%s:%s\\n' REATTACHED $$\r")
  await until(() => output.includes(`DF_REATTACHED:${pid}`))
  const buffer = terminal.buffer.active
  const visible = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString()).join("\n")
  require(visible.includes("DF_UNICODE:终端"), "xterm did not render the UTF-8 output")
  client.close()
  // Hangup must work after the data peer is gone and affect only its own shell.
  await deskfleet.terminal.hangup(terminalId)
  const remaining = await deskfleet.terminal.list()
  require(remaining.length === 1 && remaining[0]!.id === secondId, "Hangup affected the wrong shell")
  client = newClient()
  await attach(secondId)
  await client.input(secondId, "exit 7\r")
  await until(() => exitCode === 7)
  client.close()
  await deskfleet.terminal.hangup(secondId)
  require((await deskfleet.terminal.list()).length === 0, "Hung-up terminals remain in the catalog")
  terminal.dispose()
  terminalSmoke.finish({ result: { dataOnly: true, replayedBytes, reattachedPid: pid, multipleShells: true, imageReplayed: true, signalingHangup: true, exitCode } })
}

void (terminalSmoke.context.phase === "resume" ? restoreHistory() : writeHistory()).catch(error => {
  client?.close()
  terminalSmoke.finish({ error: String(error) })
})
