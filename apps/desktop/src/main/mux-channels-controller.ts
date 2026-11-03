import type { MuxStream } from "@deskfleet/client/mux/connection"
import { LOCAL_CHANNEL_BUFFER_BYTES, LOCAL_CHANNEL_BUFFER_MESSAGES, LOCAL_CHANNEL_MESSAGE_BYTES, type LocalChannelOpen } from "@deskfleet/client/local-channels"
import type { LocalChannelDelivery } from "./local-channels-controller.ts"
import { RelayConnectionError } from "@deskfleet/client/relay"

export type OpenMuxStream = (request: LocalChannelOpen) => Promise<MuxStream | undefined>
interface Delivery {
  resolve(): void
  timer: ReturnType<typeof setTimeout>
  bytes: number
}
interface Connection {
  id: string
  stream?: MuxStream
  ready: boolean
  bytes: number
  messages: number
  sequence: number
  deliveryBytes: number
  deliveries: Map<number, Delivery>
  sending: Promise<void>
}

/** Retiring a document closes its logical streams while main keeps the shared peer. */
export class WindowMuxChannels {
  readonly #open: OpenMuxStream
  readonly #emit: (event: LocalChannelDelivery) => void
  readonly #connections = new Map<string, Connection>()
  #disposed = false

  constructor(open: OpenMuxStream, emit: (event: LocalChannelDelivery) => void) {
    this.#open = open
    this.#emit = emit
  }

  async open(request: LocalChannelOpen): Promise<void> {
    if (this.#disposed) throw new Error("Mux channel window has closed")
    if (this.#connections.has(request.connectionId)) throw new Error("Mux channel already exists")
    const connection: Connection = {
      id: request.connectionId, ready: false, bytes: 0, messages: 0, sequence: 0, deliveryBytes: 0,
      deliveries: new Map(), sending: Promise.resolve(),
    }
    this.#connections.set(connection.id, connection)
    try {
      const stream = await this.#open(request)
      if (!stream) throw new Error("Mux transport is unsupported")
      if (!this.#current(connection)) { stream.close(); throw new Error("Mux channel was cancelled") }
      connection.stream = stream
      stream.onClose = error => this.#retire(connection, error)
      stream.onData = data => this.#receive(connection, data)
      if (!this.#current(connection) || stream.state !== "open") throw new Error("Mux channel was closed while opening")
      connection.ready = true
    } catch (error) {
      this.#retire(connection, error)
      throw error
    }
  }

  send(id: string, value: string | Uint8Array): Promise<void> {
    const connection = this.#owned(id)
    const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength
    if (bytes > LOCAL_CHANNEL_MESSAGE_BYTES) throw new Error("Mux channel message is too large")
    if (connection.bytes + bytes > LOCAL_CHANNEL_BUFFER_BYTES || connection.messages >= LOCAL_CHANNEL_BUFFER_MESSAGES) throw new Error("Mux channel send buffer is full")
    const data = typeof value === "string" ? value : value.slice()
    connection.bytes += bytes
    connection.messages += 1
    const sending = connection.sending.then(async () => {
      if (!this.#current(connection)) throw new Error("Mux channel was closed")
      await connection.stream!.send(data)
    }).catch(error => {
      this.#retire(connection, error)
      throw error
    }).finally(() => { connection.bytes -= bytes; connection.messages -= 1 })
    connection.sending = sending.catch(() => {})
    return sending
  }

  async acknowledge(id: string, sequence: number): Promise<void> {
    const connection = this.#connections.get(id)
    // Delivery can precede resolution of open(); accept its ACK while opening.
    if (!connection || !this.#current(connection)) throw new Error("Mux channel is not open in this window")
    const delivery = connection.deliveries.get(sequence)
    if (!delivery) return
    connection.deliveries.delete(sequence)
    connection.deliveryBytes -= delivery.bytes
    clearTimeout(delivery.timer)
    delivery.resolve()
  }

  async close(id: string): Promise<void> {
    const connection = this.#connections.get(id)
    if (connection) this.#retire(connection)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const connection of this.#connections.values()) this.#retire(connection, "Mux channel window has closed")
  }

  #current(connection: Connection): boolean {
    return !this.#disposed && this.#connections.get(connection.id) === connection
  }

  #owned(id: string): Connection {
    const connection = this.#connections.get(id)
    if (!connection?.ready || !connection.stream || !this.#current(connection)) throw new Error("Mux channel is not open in this window")
    return connection
  }

  #receive(connection: Connection, data: string | Uint8Array): Promise<void> {
    if (!this.#current(connection)) return Promise.resolve()
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
    if (bytes > LOCAL_CHANNEL_MESSAGE_BYTES || connection.deliveryBytes + bytes > LOCAL_CHANNEL_BUFFER_BYTES || connection.deliveries.size >= LOCAL_CHANNEL_BUFFER_MESSAGES) {
      this.#retire(connection, "Mux channel receive buffer is full")
      return Promise.resolve()
    }
    const sequence = ++connection.sequence
    connection.deliveryBytes += bytes
    return new Promise(resolve => {
      const timer = setTimeout(() => this.#retire(connection, "Mux renderer delivery timed out"), 5_000)
      connection.deliveries.set(sequence, { resolve, timer, bytes })
      try { this.#emit({ connectionId: connection.id, kind: "message", sequence, data }) }
      catch (error) { this.#retire(connection, error instanceof Error ? error.message : String(error)) }
    })
  }

  #retire(connection: Connection, reason?: unknown): void {
    if (this.#connections.get(connection.id) !== connection) return
    this.#connections.delete(connection.id)
    connection.ready = false
    if (connection.stream) {
      connection.stream.onClose = undefined
      connection.stream.onData = undefined
      connection.stream.close()
    }
    for (const delivery of connection.deliveries.values()) {
      clearTimeout(delivery.timer)
      delivery.resolve()
    }
    connection.deliveries.clear()
    connection.deliveryBytes = 0
    const error = reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason)
    const relayDeniedReason = reason instanceof RelayConnectionError ? reason.relayDeniedReason : undefined
    this.#emit({ connectionId: connection.id, kind: "closed", ...(error ? { error } : {}), ...(relayDeniedReason ? { relayDeniedReason } : {}) })
  }
}
