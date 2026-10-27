import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { open, stat, type FileHandle } from "node:fs/promises"
import { FILE_CHUNK_BYTES, FILE_MAX_OPEN_READS, type FileMethods, type FileReply } from "./files-protocol.ts"
import { absolutePath, fileError, text, whole } from "./files-paths.ts"

interface ReadSession { path: string; handle: FileHandle; initial: Stats }

/** A source handle belongs to an explicit read session on one file endpoint. */
export class FileReads {
  readonly #sessions = new Map<string, ReadSession>()

  async open(params: FileMethods["openRead"]["params"]): Promise<{ readId: string }> {
    if (this.#sessions.size >= FILE_MAX_OPEN_READS) throw fileError("Too many open file reads", "busy")
    const path = absolutePath(params.path)
    if (params.modifiedAt !== undefined && (!Number.isFinite(params.modifiedAt) || params.modifiedAt < 0)) throw fileError("Invalid file timestamp", "invalid")
    const handle = await open(path, "r")
    try {
      const initial = await handle.stat()
      if (!initial.isFile()) throw fileError("Only regular files can be read", "unsupported")
      if (params.modifiedAt !== undefined && params.modifiedAt !== initial.mtimeMs) throw fileError("Source file changed during transfer", "changed")
      const readId = randomUUID()
      this.#sessions.set(readId, { path, handle, initial })
      return { readId }
    } catch (error) { await handle.close(); throw error }
  }

  async #validate(session: ReadSession): Promise<void> {
    const current = await stat(session.path)
    const initial = session.initial
    if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) {
      throw fileError("Source file changed during transfer", "changed")
    }
  }

  async read(params: FileMethods["read"]["params"]): Promise<FileReply<{ bytes: number }>> {
    const offset = whole(params.offset, "read offset"), length = whole(params.length, "read length")
    if (!length || length > FILE_CHUNK_BYTES) throw fileError("Invalid file chunk size", "invalid")
    const owned = params.readId === undefined
    const readId = owned ? (await this.open(params)).readId : text(params.readId, "read ID")
    const session = this.#sessions.get(readId)
    if (!session) throw fileError("File read was not found", "not_found")
    try {
      if (absolutePath(params.path) !== session.path) throw fileError("File read path does not match its session", "invalid")
      if (params.modifiedAt !== undefined && params.modifiedAt !== session.initial.mtimeMs) throw fileError("Source file changed during transfer", "changed")
      if (offset > session.initial.size) throw fileError("Read offset exceeds file size", "invalid")
      const buffer = Buffer.alloc(Math.min(length, session.initial.size - offset))
      const { bytesRead } = await session.handle.read(buffer, 0, buffer.length, offset)
      // No bytes leave the endpoint until the path still identifies the original
      // file with the metadata captured when this read session opened.
      await this.#validate(session)
      return { value: { bytes: bytesRead }, data: buffer.subarray(0, bytesRead) }
    } finally { if (owned) await this.release({ readId }) }
  }

  async release(params: FileMethods["closeRead"]["params"]): Promise<null> {
    const readId = text(params.readId, "read ID")
    const session = this.#sessions.get(readId)
    if (!session) return null
    this.#sessions.delete(readId)
    try { await this.#validate(session) }
    finally { await session.handle.close() }
    return null
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    await Promise.all(sessions.map(session => session.handle.close()))
  }
}
