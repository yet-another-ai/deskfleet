import { FILE_CHUNK_BYTES, FILE_RPC_METADATA_BYTES, type FileMethod } from "./files-protocol.ts"

// Bound file wire fragments below the native DataChannel's 64 KiB message limit.
export const FILE_WIRE_CHUNK_BYTES = 65_535
export interface FileFrameHeader {
  id: number; method?: FileMethod; params?: unknown; value?: unknown
  error?: { message: string; code?: string }
}
export interface FileFrame { header: FileFrameHeader; data: Uint8Array; metadataBytes: number }

/** Length-prefixed JSON metadata followed by raw bytes; no base64 expansion. */
export function encodeFileFrame(header: FileFrameHeader, data: Uint8Array = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  if (json.length > FILE_RPC_METADATA_BYTES || data.length > FILE_CHUNK_BYTES) throw new Error("File frame exceeds the size limit")
  const result = new Uint8Array(8 + json.length + data.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, json.length); view.setUint32(4, data.length)
  result.set(json, 8); result.set(data, 8 + json.length)
  return result
}

/** Allocate each bounded frame once, even when the peer fragments its length prefix. */
export class FileFrameDecoder {
  #prefix = new Uint8Array(8)
  #prefixLength = 0
  #body: Uint8Array | undefined
  #bodyLength = 0
  #headerLength = 0

  push(chunk: Uint8Array): FileFrame[] {
    const frames: FileFrame[] = []
    let offset = 0
    while (offset < chunk.length) {
      if (!this.#body) {
        const count = Math.min(8 - this.#prefixLength, chunk.length - offset)
        this.#prefix.set(chunk.subarray(offset, offset + count), this.#prefixLength)
        this.#prefixLength += count; offset += count
        if (this.#prefixLength < 8) break
        const view = new DataView(this.#prefix.buffer)
        this.#headerLength = view.getUint32(0)
        const bytes = view.getUint32(4)
        if (this.#headerLength < 2 || this.#headerLength > FILE_RPC_METADATA_BYTES || bytes > FILE_CHUNK_BYTES) throw new Error("Invalid file frame length")
        this.#body = new Uint8Array(this.#headerLength + bytes)
        this.#bodyLength = 0
      }
      const count = Math.min(this.#body.length - this.#bodyLength, chunk.length - offset)
      this.#body.set(chunk.subarray(offset, offset + count), this.#bodyLength)
      this.#bodyLength += count; offset += count
      if (this.#bodyLength < this.#body.length) continue
      const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#body.subarray(0, this.#headerLength)))
      if (!header || typeof header !== "object" || !("id" in header) || !Number.isSafeInteger(header.id) || Number(header.id) < 1) throw new Error("Invalid file frame header")
      frames.push({ header: header as FileFrameHeader, data: this.#body.subarray(this.#headerLength), metadataBytes: 8 + this.#headerLength })
      this.#body = undefined; this.#prefixLength = 0
    }
    return frames
  }
}
