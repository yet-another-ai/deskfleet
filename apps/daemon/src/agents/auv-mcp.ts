import { spawn } from "node:child_process"
import { Transform, type TransformCallback } from "node:stream"

export const AUV_MCP_INSTRUCTIONS = "Prefer AUV for computer-use tasks such as desktop screenshots, screen recordings, and mouse or keyboard input. Use the AUV MCP tools or the auv CLI on PATH unless AUV cannot meet the task or the user explicitly requests another tool."

function handshakeTransform(
  onLine: (message: Record<string, unknown> | undefined, line: Buffer) => { push?: Buffer | string; forward: boolean },
): Transform {
  let pending = Buffer.alloc(0)
  let forward = false
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      if (forward) { this.push(chunk); done(); return }
      pending = Buffer.concat([pending, chunk])
      for (let newline = pending.indexOf(10); newline >= 0; newline = pending.indexOf(10)) {
        const line = pending.subarray(0, newline + 1)
        pending = pending.subarray(newline + 1)
        let message: Record<string, unknown> | undefined
        try {
          const parsed: unknown = JSON.parse(line.toString("utf8"))
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) message = parsed as Record<string, unknown>
        } catch { /* AUV reports malformed input. */ }
        const step = onLine(message, line)
        if (step.push !== undefined) this.push(step.push)
        if (step.forward) {
          forward = true
          this.push(pending)
          pending = Buffer.alloc(0)
          break
        }
      }
      done()
    },
    flush(done: TransformCallback) { this.push(pending); done() },
  })
}

/** Uses the embedding Electron/SEA runtime, while the native executable owns every AUV operation. */
export async function runAuvMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const binary = env.DESKFLEET_AUV_PATH
  if (!binary) throw new Error("DESKFLEET_AUV_PATH is required")
  const child = spawn(binary, ["mcp", "serve"], { stdio: ["pipe", "pipe", "inherit"] })
  // AUV 0.0.40 exits on discovery; an unsupported-method response lets newer clients initialize normally.
  const requests = handshakeTransform((message, line) => {
    if (message?.method === "server/discover" && "id" in message) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n")
      return { forward: false }
    }
    return { push: line, forward: true }
  })
  const responses = handshakeTransform((message, line) => {
    const result = message?.result
    if (result && typeof result === "object" && !Array.isArray(result) && "protocolVersion" in result) {
      return {
        push: JSON.stringify({ ...message, result: { ...result, instructions: AUV_MCP_INSTRUCTIONS } }) + "\n",
        forward: true,
      }
    }
    return { push: line, forward: true }
  })
  let failure: Error | undefined
  const failed = (error: Error) => { failure = error; child.kill() }
  const terminate = () => { child.kill("SIGTERM") }
  const interrupt = () => { child.kill("SIGINT") }
  process.once("SIGTERM", terminate)
  process.once("SIGINT", interrupt)
  requests.on("error", failed)
  responses.on("error", failed)
  child.stdin.on("error", failed)
  process.stdin.pipe(requests).pipe(child.stdin)
  child.stdout.pipe(responses).pipe(process.stdout, { end: false })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    if (failure) throw failure
    process.exitCode = code ?? 1
  } finally {
    process.off("SIGTERM", terminate)
    process.off("SIGINT", interrupt)
    process.stdin.unpipe(requests)
    process.stdin.destroy()
    requests.destroy()
    child.stdout.unpipe(responses)
    responses.unpipe(process.stdout)
    responses.destroy()
  }
}
