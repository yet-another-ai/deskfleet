import { realpath } from "node:fs/promises"
import type { FileEndpoint } from "../../../daemon/src/files-protocol.ts"
import { FileTransferManager } from "@deskfleet/client/file-transfers"
import type { FileConflict, FileListing, FileResourceRequest, FilesApi, FileTarget, FileTransfer, FileTransferRequest } from "@deskfleet/client/files"
import { FileGrants } from "./files-grants.ts"

interface FileDialogs {
  chooseDirectory(): Promise<string | null>
  confirmSession(directory: string): Promise<boolean>
  confirmOverwrite(path: string): Promise<boolean>
}

/** One renderer document and account epoch. Hiding its window keeps the queue alive. */
export class WindowFiles implements FilesApi {
  readonly #grants: FileGrants
  readonly #manager: FileTransferManager
  readonly #dialogs: FileDialogs
  readonly #sessionDirectory: (sessionId: string) => Promise<string>
  #closed = false

  constructor(options: FileDialogs & {
    remoteEndpoint(target: Extract<FileTarget, { kind: "machine" }>): Promise<FileEndpoint>
    sessionDirectory(sessionId: string): Promise<string>
  }) {
    this.#dialogs = options
    this.#sessionDirectory = options.sessionDirectory
    this.#grants = new FileGrants({ confirmOverwrite: path => options.confirmOverwrite(path) })
    this.#manager = new FileTransferManager({
      endpoint: async target => target.kind === "local" ? this.#grants.endpoint(target) : options.remoteEndpoint(target),
      chooseLocalDirectory: () => this.chooseLocalDirectory(),
    })
  }

  #check(): void { if (this.#closed) throw new Error("File authorization has expired; select the folder again") }
  async #live<T>(operation: () => Promise<T>): Promise<T> {
    this.#check()
    const result = await operation()
    this.#check()
    return result
  }

  async list(target: FileTarget, path?: string): Promise<FileListing> {
    return this.#live(async () => {
      const listing = await this.#manager.list(target, path)
      return target.kind === "local" ? { ...listing, grantId: target.grantId } : listing
    })
  }
  async chooseLocalDirectory(): Promise<FileListing | null> {
    return this.#live(async () => {
      const path = await this.#dialogs.chooseDirectory()
      this.#check()
      if (!path) return null
      const target = await this.#grants.issue(path, { read: true, write: true })
      return this.list(target)
    })
  }
  async authorizeLocalSession(sessionId: string): Promise<FileTarget | null> {
    return this.#live(async () => {
      // The renderer supplies an identifier, never the root to be authorized.
      const directory = await realpath(await this.#sessionDirectory(sessionId))
      this.#check()
      if (!await this.#dialogs.confirmSession(directory)) return null
      this.#check()
      if (await realpath(await this.#sessionDirectory(sessionId)) !== directory) throw new Error("Session directory changed; authorize it again")
      return this.#grants.issue(directory, { read: true, write: false, sessionId })
    })
  }
  async enqueue(request: FileTransferRequest): Promise<string> {
    return this.#live(async () => {
      if (request.source.target.kind === "local") await this.#grants.assert(request.source.target, "read", request.source.path)
      if (request.destination.target.kind === "local") await this.#grants.assert(request.destination.target, "write", request.destination.path)
      this.#check()
      return this.#manager.enqueue(request)
    })
  }
  transfers(): Promise<FileTransfer[]> { return this.#live(() => this.#manager.transfers()) }
  cancel(id: string): Promise<void> { return this.#live(() => this.#manager.cancel(id)) }
  retry(id: string, conflict?: FileConflict): Promise<void> { return this.#live(() => this.#manager.retry(id, conflict)) }
  onChanged(listener: (transfers: FileTransfer[]) => void): () => void { return this.#manager.onChanged(listener) }
  resolveResource(request: FileResourceRequest) { return this.#live(() => this.#manager.resolveResource(request)) }
  readResource(request: FileResourceRequest) { return this.#live(() => this.#manager.readResource(request)) }
  saveResource(request: FileResourceRequest) { return this.#live(() => this.#manager.saveResource(request)) }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#grants.revoke()
    await Promise.all([this.#manager.close(), this.#grants.close()])
  }
}
