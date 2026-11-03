import { DataChannelErrorEvent, type DataChannel } from "./data-channel.ts"
import type { MuxStream } from "./mux/connection.ts"

type Source = MuxStream | DataChannel
const logical = (source: Source): source is MuxStream => "onData" in source
export const MUX_UNSUPPORTED_MESSAGE = "Mux transport is unsupported"

/** A logical channel preserves the existing client API and owns only its own stream. */
export class MuxDataChannel extends EventTarget implements DataChannel {
  onopen: DataChannel["onopen"] = null
  onmessage: DataChannel["onmessage"] = null
  onclose: DataChannel["onclose"] = null
  onerror: DataChannel["onerror"] = null
  #state: RTCDataChannelState = "connecting"
  #binaryType: BinaryType = "arraybuffer"
  #threshold = 0
  #source?: Source
  #fallback: (() => Promise<DataChannel>) | undefined

  constructor(open: () => Source | undefined | Promise<Source | undefined>, fallback: () => Promise<DataChannel>) {
    super()
    this.#fallback = fallback
    this.addEventListener("open", event => this.onopen?.(event))
    this.addEventListener("message", event => this.onmessage?.(event as MessageEvent))
    this.addEventListener("close", event => this.onclose?.(event))
    this.addEventListener("error", event => this.onerror?.(event))
    void Promise.resolve().then(async () => {
      const opening = open()
      // Install bridge handlers in the same turn that constructs it, before its
      // own open microtask can flush buffered messages or report an early error.
      const source = opening instanceof Promise ? await opening : opening
      if (source) this.#bind(source)
      else await this.#legacy()
    }).catch(error => this.#fail(error))
  }
  get readyState(): RTCDataChannelState { return this.#state }
  get bufferedAmount(): number { return this.#source?.bufferedAmount ?? 0 }
  get bufferedAmountLowThreshold(): number { return this.#threshold }
  set bufferedAmountLowThreshold(value: number) {
    this.#threshold = value
    if (this.#source && !logical(this.#source)) this.#source.bufferedAmountLowThreshold = value
  }
  get binaryType(): BinaryType { return this.#binaryType }
  set binaryType(value: BinaryType) {
    this.#binaryType = value
    if (this.#source && !logical(this.#source)) this.#source.binaryType = value
  }
  #ready(): void {
    if (this.#state !== "connecting") return
    this.#state = "open"; this.#fallback = undefined
    this.dispatchEvent(new Event("open"))
  }
  #bind(source: Source): void {
    if (this.#state === "closed") { source.close(); return }
    this.#source = source
    if (logical(source)) {
      if (source.state === "closed") { this.#fail(source.error ?? new Error("Mux stream closed before opening")); return }
      source.onClose = error => error ? this.#fail(error) : this.#finish()
      source.onBufferedAmountLow = () => {
        if (this.bufferedAmount <= this.#threshold) this.dispatchEvent(new Event("bufferedamountlow"))
      }
      this.#ready()
      source.onData = value => {
        if (this.#state !== "open") return
        const data = typeof value === "string" ? value : this.#binaryType === "blob"
          ? new Blob([value.slice().buffer]) : value.slice().buffer
        this.dispatchEvent(new MessageEvent("message", { data }))
      }
    } else {
      source.binaryType = this.#binaryType; source.bufferedAmountLowThreshold = this.#threshold
      source.onopen = () => this.#ready()
      source.onmessage = ({ data }) => this.dispatchEvent(new MessageEvent("message", { data }))
      source.onclose = () => { if (this.#source === source) this.#finish() }
      source.onerror = event => {
        if (this.#source !== source) return
        const error = event instanceof DataChannelErrorEvent ? event.error : new Error("Mux bridge failed")
        if (this.#state === "connecting" && this.#fallback && (error.message === MUX_UNSUPPORTED_MESSAGE || error.message.endsWith(`: ${MUX_UNSUPPORTED_MESSAGE}`))) {
          this.#source = undefined; source.close()
          void this.#legacy().catch(reason => this.#fail(reason))
        } else this.#fail(error)
      }
      source.addEventListener("bufferedamountlow", () => this.dispatchEvent(new Event("bufferedamountlow")))
      if (source.readyState === "open") this.#ready()
      else if (source.readyState === "closed") this.#fail(new Error("Mux bridge closed before opening"))
    }
  }
  async #legacy(): Promise<void> {
    if (this.#state === "closed") return
    const fallback = this.#fallback
    this.#fallback = undefined
    if (!fallback) throw new Error(MUX_UNSUPPORTED_MESSAGE)
    this.#bind(await fallback())
  }
  send(value: string | ArrayBuffer | ArrayBufferView): void {
    const source = this.#source
    if (this.#state !== "open" || !source) throw new DOMException("Mux stream is not open", "InvalidStateError")
    if (logical(source)) {
      const data = typeof value === "string" ? value : value instanceof ArrayBuffer
        ? new Uint8Array(value).slice() : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
      void source.send(data).catch(error => this.#fail(error))
    } else source.send(value)
  }
  #fail(reason: unknown): void {
    if (this.#state === "closed") return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.dispatchEvent(new DataChannelErrorEvent(error))
    this.close()
  }
  #finish(): void {
    if (this.#state === "closed") return
    this.#state = "closed"; this.#fallback = undefined
    this.dispatchEvent(new Event("close"))
  }
  close(): void { this.#finish(); this.#source?.close() }
}
