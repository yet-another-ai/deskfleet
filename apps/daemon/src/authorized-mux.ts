import { setTimeout as delay } from "node:timers/promises"
import type { NativePeer, PeerEvent } from "@deskfleet/native"
import { MuxConnection, type MuxStream } from "../../../packages/client/src/mux/connection.ts"
import { MUX_LABELS, type MuxLane } from "../../../packages/client/src/mux/protocol.ts"

export interface MuxHandler {
  receive(data: string | Uint8Array): void
  close(): void | Promise<void>
}

function opened() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** The authorized peer owns one connection; each stream owns only its viewer/service. */
export class AuthorizedMux {
  readonly #peer: NativePeer
  readonly #authorize: () => void
  readonly #connection: MuxConnection
  readonly #opened = new Map<MuxLane, ReturnType<typeof opened>>()
  readonly #handlers = new Map<number, MuxHandler>()
  readonly #closing = new Set<Promise<void>>()
  readonly #stopping = new AbortController()
  #closed = false

  constructor(options: {
    peer: NativePeer
    authorize(): void
    create(stream: MuxStream): MuxHandler
    failed(error: unknown): void
  }) {
    this.#peer = options.peer
    this.#authorize = options.authorize
    for (const lane of Object.keys(MUX_LABELS) as MuxLane[]) this.#opened.set(lane, opened())
    this.#connection = new MuxConnection({
      role: "server",
      send: (lane, bytes) => this.#send(lane, bytes),
      accept: stream => {
        this.#authorize()
        const handler = options.create(stream)
        this.#handlers.set(stream.id, handler)
        stream.onData = data => {
          this.#authorize()
          handler.receive(data)
        }
        stream.onClose = () => { this.#closeHandler(stream.id) }
      },
      failed: options.failed,
    })
  }

  receive(event: PeerEvent): void {
    if (this.#closed || !["data", "dataChannelOpen"].includes(event.kind)) return
    const lane = (Object.keys(MUX_LABELS) as MuxLane[]).find(lane => MUX_LABELS[lane] === event.label)
    if (!lane) throw new Error("Unexpected channel on a Mux peer")
    this.#authorize()
    if (event.kind === "dataChannelOpen") this.#opened.get(lane)!.resolve()
    else {
      if (event.isString || !event.data) throw new Error("Mux channels require binary frames")
      this.#connection.receive(lane, event.data)
    }
  }

  async #send(lane: MuxLane, bytes: Uint8Array): Promise<void> {
    await this.#opened.get(lane)!.promise
    const deadline = Date.now() + 5_000
    while (!this.#closed) {
      this.#authorize()
      try {
        await this.#peer.sendData(MUX_LABELS[lane], Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        return
      } catch (error) {
        if (!/backpressure|send buffer is full/iu.test(error instanceof Error ? error.message : String(error)) || Date.now() >= deadline) throw error
        await delay(10, undefined, { signal: this.#stopping.signal })
      }
    }
    throw new Error("Mux peer closed")
  }

  #closeHandler(id: number): void {
    const handler = this.#handlers.get(id)
    if (!handler) return
    this.#handlers.delete(id)
    const pending = Promise.resolve().then(() => handler.close())
    this.#closing.add(pending)
    // Cleanup belongs to the retired stream. Report it without failing siblings,
    // and retain the rejection for the eventual peer cleanup barrier.
    void pending.then(() => this.#closing.delete(pending), error => {
      if (!this.#closed) console.error("Mux stream cleanup failed", error)
    })
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#stopping.abort()
      const error = new Error("Mux peer closed")
      for (const ready of this.#opened.values()) ready.reject(error)
      this.#connection.close(error)
      for (const id of this.#handlers.keys()) this.#closeHandler(id)
    }
    const results = await Promise.allSettled(this.#closing)
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to close Mux streams")
  }
}
