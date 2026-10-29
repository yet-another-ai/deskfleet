import { DataChannelErrorEvent, type DataChannel } from "./data-channel.ts"

export const LOCAL_CHANNEL = "deskfleet:local-channel"
export const LOCAL_CHANNEL_EVENT = "deskfleet:local-channel-event"
export const LOCAL_CHANNEL_MESSAGE_BYTES = 64 * 1024
export const LOCAL_CHANNEL_BUFFER_BYTES = 1024 * 1024
export const LOCAL_CHANNEL_BUFFER_MESSAGES = 1024

export interface LocalChannelOpen {
  connectionId: string
  teamId: string
  machineId: string
  purpose: "agent" | "terminal"
}
export type LocalChannelEvent =
  | { connectionId: string; kind: "message"; data: string | Uint8Array }
  | { connectionId: string; kind: "closed"; error?: string }

/** Plain values only: instances and EventTargets never cross Electron's context bridge. */
export interface LocalChannelsApi {
  open(options: LocalChannelOpen): Promise<void>
  send(connectionId: string, data: string | Uint8Array): Promise<void>
  close(connectionId: string): Promise<void>
  onEvent(listener: (event: LocalChannelEvent) => void): () => void
}

const bytesOf = (data: string | Uint8Array) => typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** Reliable, ordered IPC messages with the same lifecycle and buffering contract as a DataChannel. */
export class LocalDataChannel extends EventTarget implements DataChannel {
  binaryType: BinaryType = "arraybuffer"
  bufferedAmountLowThreshold = 0
  onopen: DataChannel["onopen"] = null
  onmessage: DataChannel["onmessage"] = null
  onclose: DataChannel["onclose"] = null
  onerror: DataChannel["onerror"] = null
  readonly #api: LocalChannelsApi
  readonly #id: string
  readonly #unsubscribe: () => void
  #state: RTCDataChannelState = "connecting"
  #buffered = 0
  #sending = false
  #outgoing: (string | Uint8Array)[] = []
  #incoming: (string | Uint8Array)[] = []
  #incomingBytes = 0

  constructor(api: LocalChannelsApi, options: LocalChannelOpen) {
    super()
    this.#api = api
    this.#id = options.connectionId
    this.addEventListener("open", event => this.onopen?.(event))
    this.addEventListener("message", event => this.onmessage?.(event as MessageEvent))
    this.addEventListener("close", event => this.onclose?.(event))
    this.addEventListener("error", event => this.onerror?.(event))
    this.#unsubscribe = api.onEvent(event => {
      if (event.connectionId !== this.#id || this.#state === "closed") return
      if (event.kind === "closed") {
        if (event.error) this.#fail(new Error(event.error))
        else this.#finish()
        return
      }
      const size = bytesOf(event.data)
      if (size > LOCAL_CHANNEL_MESSAGE_BYTES || this.#incomingBytes + size > LOCAL_CHANNEL_BUFFER_BYTES || this.#incoming.length >= LOCAL_CHANNEL_BUFFER_MESSAGES) {
        this.#fail(new Error("Local channel receive buffer is full")); return
      }
      if (this.#state === "connecting") {
        this.#incoming.push(typeof event.data === "string" ? event.data : event.data.slice())
        this.#incomingBytes += size
      } else this.#message(event.data)
    })
    // Start after the caller has attached its protocol handlers.
    void Promise.resolve().then(async () => {
      if (this.#state !== "connecting") return
      await api.open(options)
      if (this.#state !== "connecting") { await api.close(this.#id); return }
      this.#state = "open"
      this.dispatchEvent(new Event("open"))
      const incoming = this.#incoming.splice(0)
      this.#incomingBytes = 0
      for (const data of incoming) {
        if (this.#state !== "open") break
        this.#message(data)
      }
    }).catch(error => this.#fail(errorOf(error)))
  }

  get readyState(): RTCDataChannelState { return this.#state }
  get bufferedAmount(): number { return this.#buffered }

  send(value: string | ArrayBuffer | ArrayBufferView): void {
    if (this.#state !== "open") throw new DOMException("Local channel is not open", "InvalidStateError")
    const data = typeof value === "string" ? value : value instanceof ArrayBuffer ? new Uint8Array(value).slice() : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    const size = bytesOf(data)
    if (size > LOCAL_CHANNEL_MESSAGE_BYTES) throw new TypeError("Local channel message exceeds the 64 KiB limit")
    if (this.#buffered + size > LOCAL_CHANNEL_BUFFER_BYTES || this.#outgoing.length >= LOCAL_CHANNEL_BUFFER_MESSAGES) throw new DOMException("Local channel send buffer is full", "OperationError")
    this.#buffered += size
    this.#outgoing.push(data)
    if (!this.#sending) void this.#flush()
  }

  async #flush(): Promise<void> {
    this.#sending = true
    try {
      while (this.#state === "open" && this.#outgoing.length > 0) {
        const data = this.#outgoing.shift()!
        await this.#api.send(this.#id, data)
        if (this.#state !== "open") return
        const previous = this.#buffered
        this.#buffered -= bytesOf(data)
        if (previous > this.bufferedAmountLowThreshold && this.#buffered <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event("bufferedamountlow"))
      }
    } catch (error) { this.#fail(errorOf(error)) }
    finally { this.#sending = false }
  }

  #message(value: string | Uint8Array): void {
    const data = typeof value === "string" ? value : this.binaryType === "blob" ? new Blob([value.slice().buffer]) : value.slice().buffer
    this.dispatchEvent(new MessageEvent("message", { data }))
  }

  #fail(error: Error): void {
    if (this.#state === "closed") return
    this.dispatchEvent(new DataChannelErrorEvent(error))
    this.close()
  }

  #finish(): void {
    if (this.#state === "closed") return
    this.#state = "closed"
    this.#unsubscribe()
    this.#outgoing = []
    this.#incoming = []
    this.#incomingBytes = 0
    this.#buffered = 0
    this.dispatchEvent(new Event("close"))
  }

  close(): void {
    if (this.#state === "closed") return
    this.#finish()
    void this.#api.close(this.#id).catch(() => {})
  }
}
