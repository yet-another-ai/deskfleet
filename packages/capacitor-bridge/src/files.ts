import type { LocalFilesEndpoint } from "@deskfleet/client/browser-files"
import {
  FILE_CHUNK_BYTES,
  type FileListing,
  type FileMethod,
  type FileMethods,
  type FileReply,
} from "../../../apps/daemon/src/files-protocol.ts"

/** Each endpoint owns its native directory grants, read handles and private staging. */
export interface FilesBridgePlugin {
  filesOpen(options: { id: string }): Promise<void>
  filesChooseDirectory(options: { id: string }): Promise<{ value: FileListing | null }>
  filesCall(options: {
    id: string
    method: FileMethod
    params: FileMethods[FileMethod]["params"]
    data?: string
  }): Promise<{ value: unknown; data?: string }>
  filesClose(options: { id: string }): Promise<void>
}

function nativeError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = reason as { message?: unknown; code?: unknown } | null
  return Object.assign(new Error(typeof error?.message === "string" ? error.message : String(reason)), {
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  })
}

function encode(data: Uint8Array): string {
  if (data.byteLength > FILE_CHUNK_BYTES) throw new Error("Invalid file write")
  // Avoid spreading a complete chunk past the JS engine's argument limit.
  let binary = ""
  for (let offset = 0; offset < data.length; offset += 8192) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function decode(data: string): Uint8Array {
  if (data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4) throw new Error("Invalid file read")
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
  if (bytes.length > FILE_CHUNK_BYTES) throw new Error("Invalid file read")
  return bytes
}

/** Native disk I/O stays behind the bridge; only bounded transfer chunks enter JS. */
export class CapacitorFilesEndpoint implements LocalFilesEndpoint {
  readonly #plugin: FilesBridgePlugin
  readonly #id = crypto.randomUUID()
  #opening: Promise<void> | undefined
  #tail = Promise.resolve()
  #closed = false
  #closing: Promise<void> | undefined

  constructor(plugin: FilesBridgePlugin) { this.#plugin = plugin }

  #check(): void {
    if (this.#closed) throw new Error("Local file access is closed")
  }

  async #ready(): Promise<void> {
    this.#check()
    this.#opening ??= this.#plugin.filesOpen({ id: this.#id })
    await this.#opening
    this.#check()
  }

  async choose(): Promise<FileListing | null> {
    try {
      await this.#ready()
      const result = await this.#plugin.filesChooseDirectory({ id: this.#id })
      this.#check()
      return result.value
    } catch (error) { throw nativeError(error) }
  }

  async call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    this.#check()
    const dispatch = async (): Promise<FileReply<FileMethods[M]["result"]>> => {
      await this.#ready()
      const reply = await this.#plugin.filesCall({
        id: this.#id, method, params,
        ...(data === undefined ? {} : { data: encode(data) }),
      })
      this.#check()
      return {
        value: reply.value as FileMethods[M]["result"],
        ...(reply.data === undefined ? {} : { data: decode(reply.data) }),
      }
    }
    // The shared pipeline submits many chunks ahead. Encode one at a time so
    // native message queues don't retain another entire window of base64 data.
    // Abort must reach native code while a commit is still publishing files.
    const running = method === "abort" ? dispatch() : this.#tail.then(dispatch)
    if (method !== "abort") this.#tail = running.then(() => {}, () => {})
    try { return await running }
    catch (error) { throw nativeError(error) }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      if (this.#opening) {
        // A failed open has no native endpoint to release.
        try { await this.#opening } catch { return }
        await this.#plugin.filesClose({ id: this.#id })
      }
      await this.#tail
    })().catch(error => { throw nativeError(error) })
    return this.#closing
  }
}
