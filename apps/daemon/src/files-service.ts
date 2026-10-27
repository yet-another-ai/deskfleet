import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { FileEndpoint, FileMethod, FileMethods, FileReply } from "./files-protocol.ts"
import { absolutePath, defaultDirectory, fileEntry, fileError, fileRoots, sessionResourcePath } from "./files-paths.ts"
import { FileReads } from "./files-reads.ts"
import { FileUploads } from "./files-uploads.ts"

/** Machine-local file access shared by authorized peers and the local desktop host. */
export class FilesService implements FileEndpoint {
  readonly #sessionDirectory?: (sessionId: string) => Promise<string>
  readonly #uploads: FileUploads
  readonly #reads = new FileReads()
  #running: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(
    sessionDirectory?: (sessionId: string) => Promise<string>,
    sessionAttachmentDirectory?: (sessionId: string) => Promise<string>,
  ) {
    this.#sessionDirectory = sessionDirectory
    this.#uploads = new FileUploads(sessionAttachmentDirectory)
  }

  call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    if (this.#closed) return Promise.reject(fileError("File connection is closed", "closed"))
    const next = this.#running.then(async () => {
      if (this.#closed) throw fileError("File connection is closed", "closed")
      if (!params || typeof params !== "object" || Array.isArray(params)) throw fileError("Invalid file request", "invalid")
      if (method !== "write" && data?.byteLength) throw fileError("Unexpected file data", "invalid")
      return this.#call(method, params, data)
    })
    this.#running = next.catch(() => {})
    return next as Promise<FileReply<FileMethods[M]["result"]>>
  }

  async #call(method: FileMethod, params: FileMethods[FileMethod]["params"], data?: Uint8Array): Promise<FileReply<unknown>> {
    switch (method) {
      case "list": {
        const request = params as FileMethods["list"]["params"]
        if (request.strict !== undefined && typeof request.strict !== "boolean") throw fileError("Invalid listing mode", "invalid")
        const directory = await fileEntry(absolutePath(request.path ?? defaultDirectory()))
        if (directory.kind !== "directory") throw fileError("Path is not a directory", "invalid")
        const path = directory.path
        const entries = []
        for (const item of await readdir(path, { withFileTypes: true })) {
          try { entries.push(await fileEntry(join(path, item.name))) }
          catch (error) {
            if (request.strict) throw error
            if (["unsupported", "ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue
            throw error
          }
        }
        entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1)
        const parent = dirname(path)
        return { value: { path, parentPath: parent === path ? null : parent, homePath: defaultDirectory(), roots: await fileRoots(), entries } }
      }
      case "stat": return { value: await fileEntry(absolutePath((params as FileMethods["stat"]["params"]).path)) }
      case "resolve": {
        const request = params as FileMethods["resolve"]["params"]
        return { value: await fileEntry(await sessionResourcePath(request.sessionId, request.uri, this.#sessionDirectory)) }
      }
      case "openRead": return { value: await this.#reads.open(params as FileMethods["openRead"]["params"]) }
      case "read": return this.#reads.read(params as FileMethods["read"]["params"])
      case "closeRead": return { value: await this.#reads.release(params as FileMethods["closeRead"]["params"]) }
      case "begin": return { value: await this.#uploads.begin(params as FileMethods["begin"]["params"]) }
      case "mkdir": return { value: await this.#uploads.mkdir(params as FileMethods["mkdir"]["params"]) }
      case "write": return { value: await this.#uploads.write(params as FileMethods["write"]["params"], data) }
      case "finish": return { value: await this.#uploads.finish(params as FileMethods["finish"]["params"]) }
      case "commit": return { value: await this.#uploads.commit(params as FileMethods["commit"]["params"]) }
      case "abort": return { value: await this.#uploads.abort(params as FileMethods["abort"]["params"]) }
      default: throw fileError("Unknown file operation", "invalid")
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#running
    await Promise.all([this.#reads.close(), this.#uploads.close()])
  }
}
