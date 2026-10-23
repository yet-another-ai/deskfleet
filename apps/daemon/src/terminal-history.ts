import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, readdir, rename, rm, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { TerminalSummary } from "./terminal-protocol.ts"

export const MAX_TERMINAL_HISTORY_READ_BYTES = 64 * 1024

interface Metadata {
  terminal: TerminalSummary
  error?: string
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id)
}

function metadata(value: unknown, id: string): Metadata {
  if (!value || typeof value !== "object") throw new Error(`Invalid terminal history metadata: ${id}`)
  const record = value as Metadata
  const terminal = record.terminal
  if (!terminal || terminal.id !== id || typeof terminal.title !== "string" || typeof terminal.cwd !== "string"
    || !["running", "exited", "interrupted"].includes(terminal.status)
    || !Number.isInteger(terminal.cols) || terminal.cols < 1 || terminal.cols > 1000
    || !Number.isInteger(terminal.rows) || terminal.rows < 1 || terminal.rows > 1000
    || (terminal.exitCode !== undefined && (!Number.isInteger(terminal.exitCode) || terminal.exitCode < 0))
    || (record.error !== undefined && typeof record.error !== "string")) {
    throw new Error(`Invalid terminal history metadata: ${id}`)
  }
  return record
}

/** Append-only bytes on disk; no terminal transcript is retained in Node memory. */
export class TerminalHistory {
  #directory: string
  readonly #file: FileHandle
  #metadata: Metadata
  #end: number
  #operations: Promise<void> = Promise.resolve()
  #closing: Promise<void> | undefined
  #deleting = false

  private constructor(directory: string, file: FileHandle, record: Metadata, end: number) {
    this.#directory = directory
    this.#file = file
    this.#metadata = record
    this.#end = end
  }

  static async recover(directory: string): Promise<TerminalHistory[]> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(directory, 0o700)
    const result: TerminalHistory[] = []
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\.(?:creating|hungup)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(entry.name)) {
          // These directories were never published, or were atomically removed
          // from the catalog by an explicit hangup before cleanup was interrupted.
          await rm(join(directory, entry.name), { recursive: true, force: true })
          continue
        }
        if (!entry.isDirectory() || !validId(entry.name)) continue
        const path = join(directory, entry.name)
        const record = metadata(JSON.parse(await readFile(join(path, "session.json"), "utf8")), entry.name)
        const file = await open(join(path, "output.bin"), "r+")
        try {
          const size = (await file.stat()).size
          result.push(new TerminalHistory(path, file, record, size))
        } catch (error) {
          await file.close()
          throw error
        }
      }
      return result
    } catch (error) {
      await Promise.allSettled(result.map(history => history.close()))
      throw error
    }
  }

  static async create(directory: string, terminal: TerminalSummary): Promise<TerminalHistory> {
    if (!validId(terminal.id)) throw new Error("Invalid terminal session ID")
    const path = join(directory, terminal.id)
    const staging = join(directory, `.creating-${randomUUID()}`)
    await mkdir(staging, { mode: 0o700 })
    let file: FileHandle | undefined
    let published = false
    try {
      file = await open(join(staging, "output.bin"), "wx+", 0o600)
      const history = new TerminalHistory(staging, file, { terminal: { ...terminal } }, 0)
      await history.save(terminal)
      await file.sync()
      // Windows refuses to rename a directory that still contains an open file.
      await file.close()
      file = undefined
      await rename(staging, path)
      published = true
      return new TerminalHistory(path, await open(join(path, "output.bin"), "r+"), { terminal: { ...terminal } }, 0)
    } catch (error) {
      await file?.close()
      await rm(published ? path : staging, { recursive: true, force: true })
      throw error
    }
  }

  get terminal(): TerminalSummary { return { ...this.#metadata.terminal } }
  get error(): string | undefined { return this.#metadata.error }
  get end(): number { return this.#end }

  #serialize(operation: () => Promise<void>): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Terminal history is closed"))
    const pending = this.#operations.then(operation)
    this.#operations = pending.catch(() => {})
    return pending
  }

  async append(data: Buffer): Promise<void> {
    await this.#serialize(async () => {
      let offset = 0
      while (offset < data.length) {
        const written = await this.#file.write(data, offset, data.length - offset, this.#end + offset)
        if (written.bytesWritten === 0) throw new Error("Terminal history write made no progress")
        offset += written.bytesWritten
      }
      // Publish the new end only after the bytes are durable, so replay cannot
      // acknowledge output that exists solely in a transient process buffer.
      await this.#file.datasync()
      this.#end += data.length
    })
  }

  async save(terminal: TerminalSummary, error?: string): Promise<void> {
    const record: Metadata = { terminal: { ...terminal }, ...(error === undefined ? {} : { error }) }
    await this.#serialize(async () => {
      const path = join(this.#directory, "session.json")
      const temporary = join(this.#directory, "session.json.tmp")
      const file = await open(temporary, "w", 0o600)
      try {
        await file.writeFile(JSON.stringify(record))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
      this.#metadata = record
    })
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > MAX_TERMINAL_HISTORY_READ_BYTES) {
      throw new Error("Invalid terminal history range")
    }
    if (this.#closing) throw new Error("Terminal history is closed")
    const data = Buffer.alloc(Math.min(length, Math.max(0, this.#end - offset)))
    let read = 0
    while (read < data.length) {
      const result = await this.#file.read(data, read, data.length - read, offset + read)
      if (result.bytesRead === 0) throw new Error("Terminal history ended before its committed offset")
      read += result.bytesRead
    }
    return data
  }

  close(): Promise<void> {
    return this.#closing ??= this.#operations.then(() => this.#file.close())
  }

  async remove(): Promise<void> {
    await this.close()
    if (!this.#deleting) {
      const tombstone = join(dirname(this.#directory), `.hungup-${randomUUID()}`)
      await rename(this.#directory, tombstone)
      this.#directory = tombstone
      this.#deleting = true
    }
    await rm(this.#directory, { recursive: true, force: true })
  }
}
