import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { MAX_TERMINAL_HISTORY_READ_BYTES } from "../terminal-history.ts"
import type { TerminalSummary } from "../terminal-protocol.ts"
import type { TerminalSessions } from "../terminals.ts"

export interface AgentTerminalContext {
  sessions: TerminalSessions
  cwd: string
  worktreeId?: string
}

interface Handle {
  sessionId: string
  outputByteLimit?: number
  ready: Promise<TerminalSummary>
}

function exitStatus(summary: TerminalSummary): acp.TerminalExitStatus | undefined {
  return summary.status === "running" ? undefined : { exitCode: summary.exitCode ?? null }
}

/** Cancelling an ACP wait releases its listener, without stopping the command. */
async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** ACP handles are connection- and provider-session-owned; transcripts remain daemon-owned. */
export class AcpTerminals {
  readonly #context: AgentTerminalContext
  readonly #requireSession: (sessionId: string) => void
  readonly #handles = new Map<string, Handle>()
  #closed = false
  #closing?: Promise<void>

  constructor(context: AgentTerminalContext, requireSession: (sessionId: string) => void) {
    this.#context = context
    this.#requireSession = requireSession
  }

  checkpoint(): Set<string> { return new Set(this.#handles.keys()) }

  /** A failed session/new, load, resume, or fork cannot leave its early callbacks running. */
  async rollback(checkpoint: Set<string>): Promise<void> {
    await this.#stop([...this.#handles.keys()].filter(id => !checkpoint.has(id)))
  }

  async create(params: acp.CreateTerminalRequest, signal?: AbortSignal): Promise<acp.CreateTerminalResponse> {
    this.#requireSession(params.sessionId)
    if (this.#closed) throw acp.RequestError.invalidParams({ details: "ACP terminals are closed" })
    signal?.throwIfAborted()
    const cwd = params.cwd ?? this.#context.cwd
    if (!isAbsolute(cwd)) throw acp.RequestError.invalidParams({ details: "Terminal working directory must be absolute" })
    const outputByteLimit = params.outputByteLimit ?? undefined
    if (outputByteLimit !== undefined && (!Number.isSafeInteger(outputByteLimit) || outputByteLimit < 0)) {
      throw acp.RequestError.invalidParams({ details: "Terminal output byte limit must be a nonnegative integer" })
    }
    const terminalId = randomUUID()
    const ready = this.#context.sessions.run({
      terminalId, title: [params.command, ...params.args ?? []].join(" "),
      command: params.command, args: params.args, env: Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
      cwd, cols: 80, rows: 24, worktreeId: this.#context.worktreeId, kind: "acp",
    })
    // Publish the pending launch before yielding, so close/rollback owns it too.
    this.#handles.set(terminalId, { sessionId: params.sessionId, outputByteLimit, ready })
    try { await ready } catch (error) {
      this.#handles.delete(terminalId)
      throw error
    }
    if (this.#closed || signal?.aborted) {
      await this.#context.sessions.stop(terminalId)
      this.#handles.delete(terminalId)
      signal?.throwIfAborted()
      throw acp.RequestError.invalidParams({ details: "ACP terminals are closed" })
    }
    return { terminalId }
  }

  async output(params: acp.TerminalOutputRequest, signal?: AbortSignal): Promise<acp.TerminalOutputResponse> {
    const handle = this.#handle(params)
    signal?.throwIfAborted()
    await handle.ready
    const snapshot = this.#context.sessions.snapshot(params.terminalId)
    const start = Math.max(0, snapshot.end - (handle.outputByteLimit ?? snapshot.end))
    const chunks: Buffer[] = []
    for (let offset = start; offset < snapshot.end;) {
      signal?.throwIfAborted()
      const chunk = await this.#context.sessions.read(params.terminalId, offset, Math.min(MAX_TERMINAL_HISTORY_READ_BYTES, snapshot.end - offset))
      chunks.push(chunk)
      offset += chunk.length
    }
    const bytes = Buffer.concat(chunks)
    let boundary = 0
    if (start > 0) while (boundary < bytes.length && (bytes[boundary]! & 0xc0) === 0x80) boundary++
    // PTY chunks can end inside a UTF-8 character; leave that tail for the next snapshot.
    const output = new StringDecoder("utf8").write(bytes.subarray(boundary))
    return { output, truncated: start > 0, ...(exitStatus(snapshot.summary) ? { exitStatus: exitStatus(snapshot.summary) } : {}) }
  }

  async waitForExit(params: acp.WaitForTerminalExitRequest, signal?: AbortSignal): Promise<acp.WaitForTerminalExitResponse> {
    const handle = this.#handle(params)
    signal?.throwIfAborted()
    await abortable(handle.ready.then(() => this.#context.sessions.waitForExit(params.terminalId)), signal)
    return exitStatus(this.#context.sessions.snapshot(params.terminalId).summary) ?? {}
  }

  async kill(params: acp.KillTerminalRequest, signal?: AbortSignal): Promise<acp.KillTerminalResponse> {
    const handle = this.#handle(params)
    signal?.throwIfAborted()
    await handle.ready
    await this.#context.sessions.stop(params.terminalId)
    return {}
  }

  async release(params: acp.ReleaseTerminalRequest, signal?: AbortSignal): Promise<acp.ReleaseTerminalResponse> {
    const handle = this.#handle(params)
    signal?.throwIfAborted()
    await handle.ready
    await this.#context.sessions.stop(params.terminalId)
    this.#handles.delete(params.terminalId)
    return {}
  }

  close(): Promise<void> {
    this.#closed = true
    return this.#closing ??= this.#stop([...this.#handles.keys()])
  }

  #handle(params: { sessionId: string; terminalId: string }): Handle {
    this.#requireSession(params.sessionId)
    const handle = this.#handles.get(params.terminalId)
    if (this.#closed || !handle || handle.sessionId !== params.sessionId) {
      throw acp.RequestError.invalidParams({ details: "Terminal does not belong to this ACP session or has been released" })
    }
    return handle
  }

  async #stop(ids: string[]): Promise<void> {
    const results = await Promise.allSettled(ids.map(async id => {
      const handle = this.#handles.get(id)
      if (!handle) return
      // A failed launch never acquired a terminal; other failures must remain visible.
      try { await handle.ready } catch { this.#handles.delete(id); return }
      await this.#context.sessions.stop(id)
      this.#handles.delete(id)
    }))
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not stop ACP terminals")
  }
}
