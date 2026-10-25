import { setTimeout as delay } from "node:timers/promises"
import { FILE_MAX_PENDING_REQUESTS, FILE_PIPELINE_BYTES, FILE_RPC_METADATA_BYTES, FILE_RPC_QUEUE_BYTES, type FileEndpoint, type FileMethod, type FileMethods } from "./files-protocol.ts"
import { encodeFileFrame, FileFrameDecoder, FILE_WIRE_CHUNK_BYTES, type FileFrame, type FileFrameHeader } from "./files-wire.ts"

const METHODS = new Set<FileMethod>(["list", "stat", "resolve", "read", "begin", "mkdir", "write", "finish", "commit", "abort"])
const READ_METHODS = new Set<FileMethod>(["list", "stat", "resolve", "read"])
export const fileAction = (method: FileMethod): "files:read" | "files:write" => READ_METHODS.has(method) ? "files:read" : "files:write"
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** One authenticated file peer. Closing it aborts its unfinished destination writes. */
export class FilesChannel {
  readonly #endpoint: FileEndpoint
  readonly #send: (data: Uint8Array) => Promise<void>
  readonly #authorize: (method: FileMethod) => void
  readonly #failure: (error: unknown) => void
  readonly #decoder = new FileFrameDecoder()
  readonly #pending = new Set<number>()
  readonly #closing = new AbortController()
  #sending: Promise<void> = Promise.resolve()
  #queuedBytes = 0
  #pendingPayloadBytes = 0
  #pendingMetadataBytes = 0
  #closed = false
  #close?: Promise<void>

  constructor(endpoint: FileEndpoint, send: (data: Uint8Array) => Promise<void>, authorize: (method: FileMethod) => void, failure: (error: unknown) => void) {
    this.#endpoint = endpoint; this.#send = send; this.#authorize = authorize; this.#failure = failure
  }

  receive(data: Uint8Array, isString = false): void {
    if (this.#closed) return
    try {
      if (isString || data.byteLength > FILE_WIRE_CHUNK_BYTES) throw new Error(`Files channel requires binary chunks up to ${FILE_WIRE_CHUNK_BYTES} bytes`)
      for (const frame of this.#decoder.push(data)) {
        const { header } = frame
        if (!header.method || !METHODS.has(header.method) || "value" in header || "error" in header) throw new Error("Invalid file request")
        if (this.#pending.has(header.id) || this.#pending.size >= FILE_MAX_PENDING_REQUESTS) throw new Error("Too many pending file requests or duplicate request ID")
        if (this.#pendingPayloadBytes + frame.data.byteLength > FILE_PIPELINE_BYTES) throw new Error("File request payload queue is full")
        if (this.#pendingMetadataBytes + frame.metadataBytes > FILE_RPC_METADATA_BYTES) throw new Error("File request metadata queue is full")
        this.#authorize(header.method)
        this.#pending.add(header.id)
        this.#pendingPayloadBytes += frame.data.byteLength
        this.#pendingMetadataBytes += frame.metadataBytes
        void this.#request(frame).catch(error => this.#fail(error)).finally(() => {
          this.#pending.delete(header.id)
          this.#pendingPayloadBytes -= frame.data.byteLength
          this.#pendingMetadataBytes -= frame.metadataBytes
        })
      }
    } catch (error) { this.#fail(error) }
  }

  async #request(frame: FileFrame): Promise<void> {
    const method = frame.header.method!
    let response: FileFrameHeader
    let data: Uint8Array | undefined
    try {
      this.#authorize(method)
      const result = await this.#endpoint.call(method, frame.header.params as FileMethods[FileMethod]["params"], frame.data)
      response = { id: frame.header.id, value: result.value }
      data = result.data
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      response = { id: frame.header.id, error: { message: errorMessage(error), ...(typeof code === "string" ? { code } : {}) } }
    }
    if (this.#closed) return
    const bytes = encodeFileFrame(response, data)
    if (this.#queuedBytes + bytes.byteLength > FILE_RPC_QUEUE_BYTES) throw new Error("File viewer cannot keep up")
    this.#queuedBytes += bytes.byteLength
    const sending = this.#sending.then(async () => {
      for (let offset = 0; offset < bytes.byteLength && !this.#closed; offset += FILE_WIRE_CHUNK_BYTES) {
        this.#authorize(method)
        await this.#sendChunk(bytes.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES), method)
      }
    }).finally(() => { this.#queuedBytes -= bytes.byteLength })
    this.#sending = sending.catch(() => {})
    await sending
  }

  async #sendChunk(data: Uint8Array, method: FileMethod): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!this.#closed) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped: (() => void) | undefined
      try {
        this.#authorize(method)
        await Promise.race([
          this.#send(data),
          new Promise<never>((_, reject) => {
            stopped = () => reject(new Error("File channel closed"))
            this.#closing.signal.addEventListener("abort", stopped, { once: true })
            timer = setTimeout(() => reject(new Error("File send buffer stalled")), Math.max(1, deadline - Date.now()))
          }),
        ])
        return
      } catch (error) {
        if (!/backpressure|send buffer is full/iu.test(errorMessage(error)) || Date.now() >= deadline) throw error
        await delay(10, undefined, { signal: this.#closing.signal })
      } finally {
        clearTimeout(timer)
        if (stopped) this.#closing.signal.removeEventListener("abort", stopped)
      }
    }
  }

  #fail(error: unknown): void {
    if (this.#closed) return
    this.#failure(error)
    void this.close().catch(cleanup => this.#failure(cleanup))
  }

  close(): Promise<void> {
    if (this.#close) return this.#close
    this.#closed = true
    this.#closing.abort()
    this.#pending.clear()
    this.#close = this.#endpoint.close()
    return this.#close
  }
}
