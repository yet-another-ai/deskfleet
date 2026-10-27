import { FILE_CHUNK_BYTES, type FileEndpoint, type FileEntry } from "../../../apps/daemon/src/files-protocol.ts"
import { filePathToUri, type FileAttachmentUploadRequest, type FileAttachmentUploadResult, type FileConflict, type FileListing, type FileResourceRequest, type FilesApi, type FileTarget, type FileTransfer, type FileTransferRequest } from "./files.ts"
import { copyFileChunks } from "./file-pipeline.ts"

const PREVIEW_BYTES = 16 * 1024 * 1024
const targetKey = (target: FileTarget) => target.kind === "local" ? `local/${target.grantId ?? ""}` : `${target.teamId}/${target.machineId}`
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error)
interface Job { value: FileTransfer; conflict: FileConflict; cancelled: boolean; run?: Promise<void>; abort?: () => Promise<void> }
interface ManifestEntry { file: FileEntry; relative: string }

function mimeType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/vnd.microsoft.icon", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", txt: "text/plain", md: "text/plain", csv: "text/plain", ts: "text/plain", js: "text/plain", rs: "text/plain", py: "text/plain" } as Record<string, string>)[extension] ?? "application/octet-stream"
}

/** The app/account owns this queue; closing a view never interrupts a transfer. */
export class FileTransferManager implements FilesApi {
  readonly #factory: (target: FileTarget) => Promise<FileEndpoint>
  readonly #choose: () => Promise<FileListing | null>
  readonly #endpoints = new Map<string, Promise<FileEndpoint>>()
  readonly #jobs: Job[] = []
  readonly #listeners = new Set<(transfers: FileTransfer[]) => void>()
  #draining: Promise<void> | undefined
  #closed = false

  constructor(options: { endpoint(target: FileTarget): Promise<FileEndpoint>; chooseLocalDirectory(): Promise<FileListing | null> }) {
    this.#factory = options.endpoint
    this.#choose = options.chooseLocalDirectory
  }

  async #endpoint(target: FileTarget): Promise<FileEndpoint> {
    if (this.#closed) throw new Error("File transfers are closed")
    const key = targetKey(target)
    let endpoint = this.#endpoints.get(key)
    if (!endpoint) {
      endpoint = this.#factory(target)
      this.#endpoints.set(key, endpoint)
      void endpoint.catch(() => { if (this.#endpoints.get(key) === endpoint) this.#endpoints.delete(key) })
    }
    return endpoint
  }

  async list(target: FileTarget, path?: string): Promise<FileListing> {
    return (await (await this.#endpoint(target)).call("list", path === undefined ? {} : { path })).value
  }
  chooseLocalDirectory(): Promise<FileListing | null> { return this.#choose() }
  async transfers(): Promise<FileTransfer[]> { return this.#snapshot() }
  onChanged(listener: (transfers: FileTransfer[]) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #snapshot(): FileTransfer[] { return this.#jobs.map(job => structuredClone(job.value)) }
  #emit(): void { for (const listener of this.#listeners) listener(this.#snapshot()) }

  async enqueue(request: FileTransferRequest): Promise<string> {
    if (this.#closed) throw new Error("File transfers are closed")
    const name = request.source.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? request.source.path
    const job: Job = {
      value: { id: crypto.randomUUID(), name, kind: request.kind ?? "file", source: structuredClone(request.source), destination: structuredClone(request.destination), state: "queued", transferredBytes: 0, totalBytes: null, bytesPerSecond: 0 },
      conflict: request.conflict ?? "ask", cancelled: false,
    }
    this.#jobs.push(job)
    this.#emit()
    this.#drain()
    return job.value.id
  }

  #job(id: string): Job {
    const job = this.#jobs.find(job => job.value.id === id)
    if (!job) throw new Error("Unknown file transfer")
    return job
  }
  async cancel(id: string): Promise<void> {
    const job = this.#job(id)
    if (["completed", "cancelled"].includes(job.value.state)) return
    job.cancelled = true
    job.value.state = "cancelled"
    job.value.bytesPerSecond = 0
    this.#emit()
    // The receiver may still be publishing browser files after all network bytes
    // arrived. Abort immediately instead of waiting for that copy to finish.
    await Promise.all([job.run, job.abort?.().catch(() => {})])
  }
  async retry(id: string, conflict?: FileConflict): Promise<void> {
    const job = this.#job(id)
    if (!["failed", "cancelled", "conflict"].includes(job.value.state)) throw new Error("This transfer is still active")
    await job.run
    if (this.#closed) throw new Error("File transfers are closed")
    job.cancelled = false
    job.conflict = conflict ?? job.conflict
    Object.assign(job.value, { state: "queued", transferredBytes: 0, totalBytes: null, bytesPerSecond: 0, error: undefined })
    this.#emit()
    this.#drain()
  }

  #drain(): void {
    if (this.#draining || this.#closed) return
    this.#draining = (async () => {
      let job: Job | undefined
      while (!this.#closed && (job = this.#jobs.find(job => job.value.state === "queued"))) {
        job.run = this.#copy(job)
        await job.run
        job.run = undefined
      }
    })().finally(() => { this.#draining = undefined; if (!this.#closed && this.#jobs.some(job => job.value.state === "queued")) this.#drain() })
  }
  #check(job: Job): void { if (job.cancelled || this.#closed) throw new Error("Transfer cancelled") }

  async #scan(endpoint: FileEndpoint, file: FileEntry, relative: string, manifest: ManifestEntry[], job: Job): Promise<void> {
    this.#check(job)
    manifest.push({ file, relative })
    if (file.kind === "file") return
    const listing = (await endpoint.call("list", { path: file.path, strict: true })).value
    this.#check(job)
    for (const entry of listing.entries) {
      if (!entry.name || /[\\/:]/u.test(entry.name) || entry.name === "." || entry.name === "..") throw new Error(`Cannot transfer this filename: ${entry.name}`)
      await this.#scan(endpoint, entry, relative ? `${relative}/${entry.name}` : entry.name, manifest, job)
    }
  }

  async #copy(job: Job): Promise<void> {
    let destination: FileEndpoint | undefined
    let transferId: string | undefined
    let failedState: "failed" | "conflict" | undefined
    let lastTime = performance.now(), lastBytes = 0
    const sample = () => {
      const now = performance.now(), elapsed = now - lastTime
      if (elapsed < 250) return
      const speed = (job.value.transferredBytes - lastBytes) * 1000 / elapsed
      job.value.bytesPerSecond = job.value.bytesPerSecond ? job.value.bytesPerSecond * .65 + speed * .35 : speed
      lastTime = now; lastBytes = job.value.transferredBytes
      this.#emit()
    }
    try {
      job.value.state = "preparing"; this.#emit()
      const source = await this.#endpoint(job.value.source.target)
      destination = await this.#endpoint(job.value.destination.target)
      this.#check(job)
      const root = (await source.call("stat", { path: job.value.source.path })).value
      job.value.name = root.name; job.value.kind = root.kind
      if (source === destination || (job.value.source.target.kind === "local" && job.value.destination.target.kind === "local")) {
        const directory = (await destination.call("list", { path: job.value.destination.path })).value.path
        const normalize = (path: string) => {
          const result = path.replaceAll("\\", "/").replace(/\/+$/u, "")
          return /^[a-z]:/iu.test(result) ? result.toLowerCase() : result
        }
        const sourcePath = normalize(root.path), targetPath = normalize(directory)
        if (root.kind === "directory" ? targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`) : normalize(`${directory}/${root.name}`) === sourcePath) throw new Error("A file or folder cannot be copied into itself")
      }
      const manifest: ManifestEntry[] = []
      await this.#scan(source, root, "", manifest, job)
      const total = manifest.reduce((total, entry) => total + (entry.file.kind === "file" ? entry.file.size : 0), 0)
      if (!Number.isSafeInteger(total)) throw new Error("Transfer size exceeds the supported range")
      job.value.totalBytes = total
      this.#check(job)
      const started = (await destination.call("begin", { directory: job.value.destination.path, name: root.name, kind: root.kind, conflict: job.conflict })).value
      transferId = started.transferId || undefined
      if (transferId) {
        const receiver = destination, id = transferId
        let cleanup: Promise<void> | undefined
        job.abort = () => cleanup ??= receiver.call("abort", { transferId: id }).then(() => {})
      }
      this.#check(job)
      if (started.skipped) { job.value.state = "cancelled"; return }
      if (!transferId) throw new Error("Receiver did not open the transfer")
      job.value.state = "transferring"; this.#emit()
      lastTime = performance.now()
      for (const entry of manifest) {
        this.#check(job)
        if (entry.file.kind === "directory") {
          await destination.call("mkdir", { transferId, path: entry.relative })
          continue
        }
        await copyFileChunks({
          source, destination, transferId, file: entry.file, path: entry.relative,
          check: () => this.#check(job),
          progress: bytes => { job.value.transferredBytes += bytes; sample() },
        })
        this.#check(job)
        await destination.call("finish", { transferId, path: entry.relative, size: entry.file.size })
      }
      this.#check(job)
      const committed = await destination.call("commit", { transferId })
      transferId = undefined
      job.value.state = committed.value.skipped ? "cancelled" : "completed"
    } catch (error) {
      if (job.cancelled || this.#closed) {
        job.value.state = "cancelled"
        if (error instanceof Error && "code" in error && error.code === "partial_copy") job.value.error = reasonOf(error)
      }
      else {
        failedState = error instanceof Error && "code" in error && error.code === "conflict" ? "conflict" : "failed"
        job.value.error = reasonOf(error)
      }
    } finally {
      if (transferId) {
        try { await job.abort?.() }
        catch (error) { if (!this.#closed) job.value.error = [job.value.error, `Partial transfer cleanup failed: ${reasonOf(error)}`].filter(Boolean).join("; ") }
      }
      job.abort = undefined
      job.value.bytesPerSecond = 0
      // A terminal failure observed through transfers() also means receiver
      // cleanup has settled, including any cleanup error reported above.
      if (failedState && !job.cancelled && !this.#closed) job.value.state = failedState
      this.#emit()
    }
  }

  async resolveResource(request: FileResourceRequest): Promise<FileEntry> {
    return (await (await this.#endpoint(request.target)).call("resolve", { sessionId: request.sessionId, uri: request.uri })).value
  }
  async readResource(request: FileResourceRequest): Promise<{ data: Uint8Array; name: string; mimeType: string }> {
    const endpoint = await this.#endpoint(request.target)
    const file = (await endpoint.call("resolve", { sessionId: request.sessionId, uri: request.uri })).value
    if (file.kind !== "file") throw new Error("Select a file to preview")
    if (file.size > PREVIEW_BYTES) throw new Error("This file is too large to preview. Download it instead.")
    const data = new Uint8Array(file.size)
    const { readId } = (await endpoint.call("openRead", { path: file.path, modifiedAt: file.modifiedAt })).value
    let readCompleted = false
    try {
      for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
        const length = Math.min(FILE_CHUNK_BYTES, file.size - offset)
        const chunk = await endpoint.call("read", { path: file.path, offset, length, modifiedAt: file.modifiedAt, readId })
        if (!chunk.data || chunk.data.byteLength !== length) throw new Error("File changed while loading the preview")
        data.set(chunk.data, offset)
      }
      readCompleted = true
    } finally {
      try { await endpoint.call("closeRead", { readId }) }
      catch (error) { if (readCompleted) throw error }
    }
    return { data, name: file.name, mimeType: mimeType(file.name) }
  }
  async saveResource(request: FileResourceRequest): Promise<string | null> {
    // Browser directory pickers require the user gesture to precede network reads.
    const directory = await this.#choose()
    if (!directory) return null
    const file = await this.resolveResource(request)
    const target: FileTarget = { kind: "local", ...(directory.grantId ? { grantId: directory.grantId } : {}) }
    return this.enqueue({ source: { target: request.target, path: file.path }, destination: { target, path: directory.path }, kind: file.kind })
  }
  async uploadAttachment(request: FileAttachmentUploadRequest): Promise<FileAttachmentUploadResult> {
    const endpoint = await this.#endpoint(request.target)
    const started = (await endpoint.call("begin", {
      sessionId: request.sessionId,
      name: request.name,
      kind: "file",
      conflict: "rename",
    })).value
    const transferId = started.transferId
    if (!transferId) throw new Error("Receiver did not open the attachment transfer")
    try {
      for (let offset = 0; offset < request.data.byteLength; offset += FILE_CHUNK_BYTES) {
        const chunk = request.data.subarray(offset, Math.min(request.data.byteLength, offset + FILE_CHUNK_BYTES))
        await endpoint.call("write", { transferId, path: "", offset }, chunk)
      }
      await endpoint.call("finish", { transferId, path: "", size: request.data.byteLength })
      const committed = (await endpoint.call("commit", { transferId })).value
      const name = committed.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? request.name
      return { path: committed.path, uri: filePathToUri(committed.path), name, size: request.data.byteLength }
    } catch (error) {
      await endpoint.call("abort", { transferId }).catch(() => {})
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const job of this.#jobs) if (["queued", "preparing", "transferring"].includes(job.value.state)) { job.cancelled = true; job.value.state = "cancelled" }
    this.#emit()
    await Promise.allSettled([...this.#endpoints.values()].map(async endpoint => (await endpoint).close()))
    await this.#draining
    this.#endpoints.clear(); this.#listeners.clear()
  }
}
