import {
  MAX_TERMINAL_MESSAGE_BYTES,
  TERMINAL_CHUNK_BYTES,
  type TerminalAck,
  type TerminalMessage,
  type TerminalRequest,
} from "./terminal-protocol.ts"
import { TerminalSessions, terminalSize } from "./terminals.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a terminal request object")
  return value as Record<string, unknown>
}

function sessionId(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("Invalid terminal session ID")
}

export function parseTerminalRequest(value: unknown): TerminalRequest | TerminalAck {
  const request = object(value)
  if ("ack" in request) {
    const ack = object(request.ack)
    sessionId(ack.sessionId)
    if (!Number.isSafeInteger(ack.offset) || (ack.offset as number) < 0) throw new Error("Invalid terminal output acknowledgement")
    return request as unknown as TerminalAck
  }
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) throw new Error("Invalid terminal request ID")
  const params = object(request.params)
  switch (request.method) {
    case "input":
      sessionId(params.sessionId)
      if (typeof params.data !== "string" || !params.data || params.data.length > TERMINAL_CHUNK_BYTES * 4 / 3 + 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(params.data)
        || Buffer.from(params.data, "base64").length > TERMINAL_CHUNK_BYTES) {
        throw new Error("Invalid terminal input")
      }
      break
    case "resize":
      sessionId(params.sessionId)
      terminalSize(params.cols, params.rows)
      break
    case "attach":
    case "detach":
      sessionId(params.sessionId)
      break
    default:
      throw new Error("Unknown terminal operation")
  }
  return request as unknown as TerminalRequest
}

interface Attachment {
  cursor: number
  replayEnd: number
  ready: boolean
  awaiting?: number
  reset: boolean
  exited: boolean
  error?: string
  pumping: boolean
  unsubscribe: () => void
}

/** One authenticated peer's terminal attachments; close detaches, never kills PTYs. */
export class TerminalChannel {
  readonly #sessions: TerminalSessions
  readonly #send: (message: string) => Promise<void>
  readonly #fail: (error: unknown) => void
  readonly #authorized: (id: string) => boolean
  readonly #attached = new Map<string, Attachment>()
  #operations: Promise<void> = Promise.resolve()
  #pendingBytes = 0
  #closed = false

  constructor(sessions: TerminalSessions, send: (message: string) => Promise<void>, fail: (error: unknown) => void, authorized: (id: string) => boolean) {
    this.#sessions = sessions
    this.#send = send
    this.#fail = fail
    this.#authorized = authorized
  }

  async receive(data: Buffer, isString: boolean): Promise<void> {
    if (this.#closed) return
    if (!isString || data.length > MAX_TERMINAL_MESSAGE_BYTES) throw new Error("Invalid terminal message")
    const value: unknown = JSON.parse(data.toString("utf8"))
    let request: TerminalRequest | TerminalAck
    try {
      request = parseTerminalRequest(value)
    } catch (error) {
      const id = object(value).id
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw error
      await this.#emit({ id, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if ("ack" in request) {
      const attachment = this.#attached.get(request.ack.sessionId)
      if (attachment && attachment.awaiting === request.ack.offset) {
        attachment.awaiting = undefined
        this.#pump(request.ack.sessionId, attachment)
      }
      return
    }
    // PTY writes may wait for the shell to read. Keep request order without
    // holding up output acknowledgements on the peer's native event consumer.
    if (this.#pendingBytes + data.length > MAX_TERMINAL_MESSAGE_BYTES * 8) throw new Error("Too much pending terminal input")
    this.#pendingBytes += data.length
    const operation = this.#operations.then(() => this.#request(request))
    this.#operations = operation.catch(() => {})
    try {
      await operation
    } finally {
      this.#pendingBytes -= data.length
    }
  }

  async #request(request: TerminalRequest): Promise<void> {
    if (this.#closed) return
    try {
      const result = await this.#handle(request)
      await this.#emit({ id: request.id, result })
      if (request.method === "attach") {
        const attachment = this.#attached.get(request.params.sessionId)
        if (attachment) this.#pump(request.params.sessionId, attachment)
      }
    } catch (error) {
      await this.#emit({ id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  close(): void {
    this.#closed = true
    for (const [id, attachment] of this.#attached) {
      attachment.unsubscribe()
      this.#sessions.release(id, this)
    }
    this.#attached.clear()
  }

  async #emit(message: TerminalMessage): Promise<void> {
    if (!this.#closed) await this.#send(JSON.stringify(message))
  }

  async #handle(request: TerminalRequest): Promise<unknown> {
    switch (request.method) {
      case "attach": {
        const { sessionId } = request.params
        if (!this.#authorized(sessionId)) throw new Error("Dial the terminal through signaling before attaching")
        const snapshot = this.#sessions.snapshot(sessionId)
        if (this.#attached.has(sessionId)) return snapshot.summary
        // ACP viewers only replay output, so they never acquire the interactive controller.
        if (snapshot.summary.kind !== "acp") this.#sessions.claim(sessionId, this)
        const attachment: Attachment = {
          cursor: 0, replayEnd: snapshot.end, ready: false, reset: true, exited: false, pumping: false, unsubscribe: () => {},
        }
        this.#attached.set(sessionId, attachment)
        attachment.unsubscribe = this.#sessions.subscribe(sessionId, reason => {
          if (reason === "hangup") {
            this.#detach(sessionId)
            void this.#emit({ event: { kind: "hungup", sessionId } }).catch(this.#fail)
          } else this.#pump(sessionId, attachment)
        })
        return snapshot.summary
      }
      case "detach":
        this.#detach(request.params.sessionId)
        return null
      case "input":
        this.#requireAttached(request.params.sessionId)
        await this.#sessions.input(request.params.sessionId, Buffer.from(request.params.data, "base64"))
        return null
      case "resize":
        this.#requireAttached(request.params.sessionId)
        await this.#sessions.resize(request.params.sessionId, request.params.cols, request.params.rows)
        return null
    }
  }

  #detach(id: string): void {
    this.#attached.get(id)?.unsubscribe()
    this.#attached.delete(id)
    this.#sessions.release(id, this)
  }

  #requireAttached(id: string): void {
    if (!this.#attached.has(id)) throw new Error("Attach to the terminal before controlling it")
  }

  #pump(id: string, attachment: Attachment): void {
    if (this.#closed || this.#attached.get(id) !== attachment || attachment.pumping || attachment.awaiting !== undefined) return
    attachment.pumping = true
    void this.#flush(id, attachment).catch(error => {
      if (this.#closed || this.#attached.get(id) !== attachment) return
      this.close()
      this.#fail(error)
    }).finally(() => {
      attachment.pumping = false
      if (this.#closed || this.#attached.get(id) !== attachment || attachment.awaiting !== undefined) return
      const snapshot = this.#sessions.snapshot(id)
      if (!attachment.ready || attachment.cursor < snapshot.end || (snapshot.summary.status === "exited" && !attachment.exited)) this.#pump(id, attachment)
    })
  }

  async #flush(id: string, attachment: Attachment): Promise<void> {
    const snapshot = this.#sessions.snapshot(id)
    if (attachment.reset) {
      attachment.reset = false
      await this.#emit({ event: { kind: "reset", sessionId: id } })
    }
    if (this.#closed || this.#attached.get(id) !== attachment) return
    if (!attachment.ready && attachment.cursor >= attachment.replayEnd) {
      attachment.ready = true
      await this.#emit({ event: { kind: "ready", sessionId: id } })
    }
    if (this.#closed || this.#attached.get(id) !== attachment) return
    if (attachment.cursor < snapshot.end) {
      const end = attachment.ready ? snapshot.end : attachment.replayEnd
      const data = await this.#sessions.read(id, attachment.cursor, Math.min(TERMINAL_CHUNK_BYTES, end - attachment.cursor))
      if (this.#closed || this.#attached.get(id) !== attachment) return
      if (!data.length) throw new Error("Terminal history ended before its persisted offset")
      attachment.cursor += data.length
      // Reserve the acknowledgement before sending, including for fast local peers.
      attachment.awaiting = attachment.cursor
      await this.#emit({ event: { kind: "output", sessionId: id, data: data.toString("base64"), offset: attachment.cursor } })
      return
    }
    if (snapshot.error && attachment.error !== snapshot.error) {
      attachment.error = snapshot.error
      await this.#emit({ event: { kind: "error", sessionId: id, error: snapshot.error } })
    }
    if (snapshot.summary.status === "exited" && !attachment.exited) {
      attachment.exited = true
      await this.#emit({ event: { kind: "exit", sessionId: id, exitCode: snapshot.summary.exitCode } })
    }
  }
}
