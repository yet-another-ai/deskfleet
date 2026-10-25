import type { FileEndpoint } from "../../../daemon/src/files-protocol.ts"
import { FileTransferManager } from "@deskfleet/client/file-transfers"
import type { FileConflict, FileListing, FileResourceRequest, FilesApi, FileTarget, FileTransfer, FileTransferRequest } from "@deskfleet/client/files"
import { FileGrants } from "./files-grants.ts"

interface FileDialogs {
  chooseDirectory(): Promise<string | null>
  confirmOverwrite(path: string): Promise<boolean>
}

/** One renderer document and account epoch. Hiding its window keeps the queue alive. */
export class WindowFiles implements FilesApi {
  readonly #grants: FileGrants
  readonly #manager: FileTransferManager
  readonly #dialogs: FileDialogs
  readonly #sessionDirectory: (sessionId: string) => Promise<string>
  readonly #sessionTargets = new Map<string, Promise<FileTarget>>()
  #localTarget: Promise<FileTarget> | undefined
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

  #check(): void { if (this.#closed) throw new Error("File access has expired; reopen the file transfer panel") }
  async #live<T>(operation: () => Promise<T>): Promise<T> {
    this.#check()
    const result = await operation()
    this.#check()
    return result
  }

  async list(target: FileTarget, path?: string): Promise<FileListing> {
    return this.#live(async () => {
      target = await this.#target(target)
      const listing = await this.#manager.list(target, path)
      return target.kind === "local" ? { ...listing, grantId: target.grantId } : listing
    })
  }
  async chooseLocalDirectory(): Promise<FileListing | null> {
    return this.#live(async () => {
      const path = await this.#dialogs.chooseDirectory()
      this.#check()
      if (!path) return null
      return this.list({ kind: "local" }, path)
    })
  }
  async #target(target: FileTarget): Promise<FileTarget> {
    if (target.kind !== "local" || target.grantId) return target
    this.#localTarget ??= this.#grants.issueLocal().catch(error => { this.#localTarget = undefined; throw error })
    return this.#localTarget
  }
  async #resource(request: FileResourceRequest): Promise<FileResourceRequest> {
    if (request.target.kind !== "local" || request.target.grantId) return request
    const { sessionId } = request
    let target = this.#sessionTargets.get(sessionId)
    if (!target) {
      target = this.#live(async () => {
        // Only the daemon supplies the captured root; the renderer supplies a Session identifier.
        const directory = await this.#sessionDirectory(sessionId)
        this.#check()
        return this.#grants.issue(directory, { read: true, write: false, sessionId })
      }).catch(error => { this.#sessionTargets.delete(sessionId); throw error })
      this.#sessionTargets.set(sessionId, target)
    }
    return { ...request, target: await target }
  }
  async enqueue(request: FileTransferRequest): Promise<string> {
    return this.#live(async () => {
      request = {
        ...request,
        source: { ...request.source, target: await this.#target(request.source.target) },
        destination: { ...request.destination, target: await this.#target(request.destination.target) },
      }
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
  resolveResource(request: FileResourceRequest) { return this.#live(async () => this.#manager.resolveResource(await this.#resource(request))) }
  readResource(request: FileResourceRequest) { return this.#live(async () => this.#manager.readResource(await this.#resource(request))) }
  saveResource(request: FileResourceRequest) { return this.#live(async () => this.#manager.saveResource(await this.#resource(request))) }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#sessionTargets.clear()
    this.#grants.revoke()
    await Promise.all([this.#manager.close(), this.#grants.close()])
  }
}
