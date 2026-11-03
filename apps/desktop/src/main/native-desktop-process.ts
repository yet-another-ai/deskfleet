import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { ViewerCommand, ViewerEvent, ViewerProcess } from "./native-desktop-session.ts"

/** The pipe carries signaling only; decoded pixels never leave the Rust process. */
export function spawnDesktopViewer(executable: string, receive: (event: ViewerEvent) => void): ViewerProcess {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  let closing: Promise<void> | undefined
  let exited = false
  let diagnostics = ""
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const report = (error: unknown) => {
    if (!closing) receive({ type: "error", error: error instanceof Error ? error.message : String(error) })
  }
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-8192) })
  child.on("error", report)
  child.stdin.on("error", report)
  child.once("close", (code, signal) => {
    exited = true
    lines.close()
    resolveExit()
    if (!closing && (code !== 0 || signal)) {
      report(new Error(`Native desktop exited (${signal ?? code ?? "unknown"})${diagnostics.trim() ? `: ${diagnostics.trim()}` : ""}`))
    } else receive({ type: "closed" })
  })
  lines.on("line", line => {
    if (closing) return
    try {
      const event: unknown = JSON.parse(line)
      if (!event || typeof event !== "object" || !("type" in event)) throw new Error("Invalid native desktop response")
      const value = event as Record<string, unknown>
      switch (value.type) {
        case "capabilities":
          if (!Array.isArray(value.codecs) || !value.codecs.every(codec => ["h264", "h265", "av1"].includes(codec))) throw new Error("Invalid native desktop capabilities")
          break
        case "offer":
          if (typeof value.sdp !== "string") throw new Error("Invalid native desktop offer")
          break
        case "candidate":
          if (!value.candidate || typeof value.candidate !== "object" || typeof (value.candidate as Record<string, unknown>).candidate !== "string") throw new Error("Invalid native desktop candidate")
          break
        case "error":
          if (typeof value.error !== "string") throw new Error("Invalid native desktop error")
          if (value.reason !== undefined && value.reason !== "decoder") throw new Error("Invalid native desktop error reason")
          break
        case "answerApplied": case "inputReady": case "videoReady": case "connected": case "disconnected": case "closeRequested": case "closed": case "stats": break
        default: throw new Error("Unknown native desktop response")
      }
      receive(event as ViewerEvent)
    } catch (error) { report(error) }
  })
  function send(command: ViewerCommand): void {
    if (exited || closing || !child.stdin.writable) throw new Error("Native desktop window closed")
    child.stdin.write(`${JSON.stringify(command)}\n`)
  }
  return {
    send,
    close() {
      if (closing) return closing
      if (exited) return Promise.resolve()
      // EOF also closes the viewer if its parent exits before sending close.
      child.stdin.end(`${JSON.stringify({ type: "close" })}\n`)
      const timeout = setTimeout(() => { child.kill("SIGKILL") }, 5_000)
      timeout.unref()
      closing = exit.finally(() => { clearTimeout(timeout) })
      return closing
    },
  }
}
