import { FILE_MAX_PENDING_REQUESTS, FILE_PIPELINE_BYTES, FILE_RPC_METADATA_BYTES, FILE_RPC_QUEUE_BYTES, type FileEndpoint, type FileMethod, type FileMethods, type FileReply } from "../../../apps/daemon/src/files-protocol.ts"
import { encodeFileFrame, FileFrameDecoder, FILE_WIRE_CHUNK_BYTES } from "../../../apps/daemon/src/files-wire.ts"

export interface FileTransport { send(data: Uint8Array): Promise<void>; close(): Promise<void> }
export type FileTransportFactory = (receive: (data: Uint8Array) => void, fail: (error: Error) => void) => Promise<FileTransport>
interface Pending { resolve(value: FileReply<unknown>): void; reject(error: Error): void; dataBytes: number; metadataBytes: number }
interface Connection {
  decoder: FileFrameDecoder; ready: Promise<FileTransport>; sending: Promise<void>; queuedBytes: number
  pendingDataBytes: number; pendingMetadataBytes: number; lastProgress: number; timer?: ReturnType<typeof setTimeout>
}
const IDLE_TIMEOUT_MS = 60_000
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** Requests never retry implicitly; a later operation can establish a new peer. */
export class FilesRpcClient implements FileEndpoint {
  readonly #factory: FileTransportFactory
  readonly #pending = new Map<number, Pending>()
  #connection: Connection | undefined
  #nextId = 0
  #closed = false

  constructor(factory: FileTransportFactory) { this.#factory = factory }

  #connect(): Connection {
    if (this.#closed) throw new Error("File connection is closed")
    if (this.#connection) return this.#connection
    const current: Connection = {
      decoder: new FileFrameDecoder(), ready: undefined!, sending: Promise.resolve(), queuedBytes: 0,
      pendingDataBytes: 0, pendingMetadataBytes: 0, lastProgress: Date.now(),
    }
    this.#connection = current
    current.ready = Promise.resolve().then(() => this.#factory(data => {
      if (this.#connection !== current) return
      try {
        if (data.byteLength) this.#progress(current)
        for (const { header, data: bytes } of current.decoder.push(data)) {
          const pending = this.#pending.get(header.id)
          if (!pending || header.method !== undefined) throw new Error("Unexpected file response")
          if (header.error && typeof header.error.message !== "string") throw new Error("Invalid file error response")
          this.#pending.delete(header.id)
          current.pendingDataBytes -= pending.dataBytes; current.pendingMetadataBytes -= pending.metadataBytes
          if (header.error) {
            pending.reject(Object.assign(new Error(header.error.message), { code: header.error.code }))
          } else pending.resolve({ value: header.value, data: bytes })
        }
        if (!this.#pending.size) { clearTimeout(current.timer); current.timer = undefined }
      } catch (error) { this.#fail(current, errorOf(error)) }
    }, error => this.#fail(current, error)))
    void current.ready.catch(error => this.#fail(current, errorOf(error)))
    return current
  }

  async call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    const current = this.#connect()
    const transport = await current.ready
    if (current !== this.#connection) throw new Error("File connection was interrupted")
    if (this.#pending.size >= FILE_MAX_PENDING_REQUESTS) throw new Error("Too many pending file requests")
    const id = ++this.#nextId
    const bytes = encodeFileFrame({ id, method, params }, data)
    const dataBytes = data?.byteLength ?? 0, metadataBytes = bytes.length - dataBytes
    if (current.pendingDataBytes + dataBytes > FILE_PIPELINE_BYTES || current.pendingMetadataBytes + metadataBytes > FILE_RPC_METADATA_BYTES) throw new Error("File request window is full")
    if (current.queuedBytes + bytes.length > FILE_RPC_QUEUE_BYTES) throw new Error("File request queue is full")
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: value => resolve(value as FileReply<FileMethods[M]["result"]>), reject, dataBytes, metadataBytes })
      current.pendingDataBytes += dataBytes; current.pendingMetadataBytes += metadataBytes
      if (!current.timer) this.#progress(current)
      current.queuedBytes += bytes.length
      current.sending = current.sending.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += FILE_WIRE_CHUNK_BYTES) {
          if (this.#connection !== current) throw new Error("File connection was interrupted")
          await transport.send(bytes.subarray(offset, offset + FILE_WIRE_CHUNK_BYTES))
          this.#progress(current)
        }
      }).catch(error => this.#fail(current, errorOf(error))).finally(() => { current.queuedBytes -= bytes.length })
    })
  }

  #progress(current: Connection): void {
    current.lastProgress = Date.now()
    if (current.timer || !this.#pending.size || this.#connection !== current) return
    // A full window may take longer than a minute on a healthy slow link.
    // Time out stalled transfers, including partially received responses.
    const check = () => {
      const remaining = IDLE_TIMEOUT_MS - (Date.now() - current.lastProgress)
      if (remaining <= 0) this.#fail(current, new Error("File request timed out"))
      else current.timer = setTimeout(check, remaining)
    }
    current.timer = setTimeout(check, IDLE_TIMEOUT_MS)
  }

  #fail(current: Connection, error: Error): void {
    if (this.#connection !== current) return
    this.#connection = undefined
    clearTimeout(current.timer)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    void current.ready.then(transport => transport.close(), () => {}).catch(() => {})
  }

  async close(): Promise<void> {
    this.#closed = true
    const current = this.#connection
    if (!current) return
    this.#fail(current, new Error("File connection is closed"))
    await current.ready.then(transport => transport.close(), () => {})
  }
}
