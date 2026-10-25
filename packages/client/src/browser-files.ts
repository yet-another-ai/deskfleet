import type { CentralApi } from "./central.ts"
import { FileTransferManager } from "./file-transfers.ts"
import { createBrowserFileEndpoint } from "./files-peer.ts"
import type { FilesApi, FileTransfer } from "./files.ts"
import { FILE_CHUNK_BYTES, type FileConflict, type FileEndpoint, type FileEntry, type FileKind, type FileListing, type FileMethod, type FileMethods, type FileReply } from "../../../apps/daemon/src/files-protocol.ts"

type DirectoryHandle = FileSystemDirectoryHandle
interface Upload {
  directory: DirectoryHandle; directoryPath: string; requestedName: string; name: string; kind: FileKind; stage: DirectoryHandle
  files: Map<string, { stream: FileSystemWritableFileStream; offset: number }>
  finished: Set<string>; conflict: FileConflict
  stop: AbortController; calls: Set<Promise<unknown>>; tail: Promise<void>
}
const codeOf = (error: unknown) => error instanceof Error ? error.name : ""
const conflict = () => Object.assign(new Error("A file or folder with this name already exists"), { code: "conflict" })
const segments = (path: string) => {
  if (!path) return []
  const values = path.split("/")
  if (values.some(value => !value || value === "." || value === ".." || /[\\:\0]/u.test(value))) throw new Error("Invalid transfer path")
  return values
}

/** Only explicitly selected browser directory handles are accessible to the local pane. */
export class BrowserFilesEndpoint implements FileEndpoint {
  readonly #roots = new Map<string, DirectoryHandle>()
  readonly #uploads = new Map<string, Upload>()
  readonly #calls = new Set<Promise<unknown>>()
  #selected: string | undefined
  #closed = false

  async choose(): Promise<FileListing | null> {
    if (this.#closed) throw new Error("Local file access is closed")
    const picker = (window as Window & { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<DirectoryHandle> }).showDirectoryPicker
    if (!picker) throw new Error("This browser cannot browse and write local folders. Use a browser with directory access support or the desktop app.")
    let handle: DirectoryHandle
    try { handle = await picker.call(window, { mode: "readwrite" }) }
    catch (error) { if (codeOf(error) === "AbortError") return null; throw error }
    if (this.#closed) throw new Error("Local file access is closed")
    let path = `/${handle.name}`
    for (let index = 2; this.#roots.has(path) && !(await this.#roots.get(path)!.isSameEntry(handle)); index++) path = `/${handle.name} (${index})`
    this.#roots.set(path, handle); this.#selected = path
    return this.#list(path)
  }

  async #handle(path: string): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> {
    const root = [...this.#roots.keys()].filter(root => path === root || path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0]
    if (!root) throw new Error("Choose a local folder first")
    const values = segments(path.slice(root.length).replace(/^\//u, ""))
    let directory = this.#roots.get(root)!
    for (const [index, name] of values.entries()) {
      if (index === values.length - 1) {
        try { return await directory.getFileHandle(name) }
        catch (error) { if (codeOf(error) !== "TypeMismatchError") throw error }
      }
      directory = await directory.getDirectoryHandle(name) as DirectoryHandle
    }
    return directory
  }
  async #directory(path: string): Promise<DirectoryHandle> {
    const handle = await this.#handle(path)
    if (handle.kind !== "directory") throw new Error("A destination folder is required")
    return handle as DirectoryHandle
  }
  async #entry(path: string, handle: FileSystemDirectoryHandle | FileSystemFileHandle): Promise<FileEntry> {
    const file = handle.kind === "file" ? await handle.getFile() : undefined
    return { path, name: handle.name, kind: handle.kind === "file" ? "file" : "directory", size: file?.size ?? 0, modifiedAt: file?.lastModified ?? 0 }
  }
  async #list(path = this.#selected): Promise<FileListing> {
    if (!path) throw new Error("Choose a local folder first")
    const directory = await this.#directory(path)
    const entries: FileEntry[] = []
    for await (const [name, handle] of directory.entries()) entries.push(await this.#entry(`${path}/${name}`, handle))
    entries.sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name))
    return { path, parentPath: this.#roots.has(path) ? null : path.slice(0, path.lastIndexOf("/")), homePath: this.#selected!, roots: [...this.#roots].map(([path, handle]) => ({ path, name: handle.name })), entries }
  }
  async #unusedName(directory: DirectoryHandle, name: string, kind: FileKind): Promise<string> {
    if (!await this.#exists(directory, name)) return name
    const dot = kind === "file" ? name.lastIndexOf(".") : -1
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ""
    for (let index = 1; ; index++) {
      const candidate = `${stem} (${index})${extension}`
      if (!await this.#exists(directory, candidate)) return candidate
    }
  }
  async #exists(directory: DirectoryHandle, name: string): Promise<FileKind | null> {
    try { await directory.getFileHandle(name); return "file" }
    catch (error) {
      if (codeOf(error) === "TypeMismatchError") return "directory"
      if (codeOf(error) === "NotFoundError") return null
      throw error
    }
  }
  async #parent(directory: DirectoryHandle, path: string, create: boolean): Promise<{ directory: DirectoryHandle; name: string }> {
    const values = segments(path)
    const name = values.pop()
    if (!name) throw new Error("A file path is required")
    for (const value of values) directory = await directory.getDirectoryHandle(value, { create }) as DirectoryHandle
    return { directory, name }
  }
  #upload(id: string): Upload {
    const upload = this.#uploads.get(id)
    if (!upload) throw new Error("Unknown file transfer")
    return upload
  }
  #filePath(upload: Upload, path: string): string {
    segments(path)
    if (upload.kind === "file") { if (path) throw new Error("Invalid root file path"); return "file" }
    if (!path) throw new Error("A file path is required")
    return `directory/${path}`
  }
  async #remove(id: string): Promise<void> {
    const upload = this.#uploads.get(id)
    if (!upload) return
    this.#uploads.delete(id)
    // A stream may already have errored or closed; still remove its private staging.
    await Promise.allSettled([...upload.files.values()].map(file => file.stream.abort()))
    const storage = await navigator.storage.getDirectory()
    await storage.removeEntry(`deskfleet-${id}`, { recursive: true })
  }
  async #abort(id: string): Promise<void> {
    const upload = this.#uploads.get(id)
    if (!upload) return
    upload.stop.abort()
    await Promise.allSettled([...upload.calls])
    await this.#remove(id)
  }
  async #copyFile(source: FileSystemFileHandle, target: FileSystemFileHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const writable = await target.createWritable()
    try { await (await source.getFile()).stream().pipeTo(writable, { signal }) }
    catch (error) { try { await writable.abort() } catch { /* pipeTo already aborts its destination */ } throw error }
  }
  async #copyDirectory(source: DirectoryHandle, target: DirectoryHandle, signal: AbortSignal): Promise<void> {
    for await (const [name, handle] of source.entries()) {
      signal.throwIfAborted()
      if (handle.kind === "directory") await this.#copyDirectory(handle as DirectoryHandle, await target.getDirectoryHandle(name, { create: true }) as DirectoryHandle, signal)
      else await this.#copyFile(handle, await target.getFileHandle(name, { create: true }), signal)
    }
  }

  async call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    if (this.#closed) throw new Error("Local file access is closed")
    const upload = "transferId" in params && method !== "abort" ? this.#uploads.get(params.transferId) : undefined
    // Pipelined chunks arrive in order, but creating/writing their browser
    // streams is asynchronous. Keep each upload's mutations in that order.
    // Abort bypasses this queue so it can stop a commit currently publishing.
    const running = upload ? upload.tail.then(() => {
      if (this.#closed) throw new Error("Local file access is closed")
      upload.stop.signal.throwIfAborted()
      return this.#dispatch(method, params, data)
    }) : this.#dispatch(method, params, data)
    if (upload) upload.tail = running.then(() => {}, () => {})
    this.#calls.add(running)
    upload?.calls.add(running)
    try { return await running as FileReply<FileMethods[M]["result"]> }
    finally { this.#calls.delete(running); upload?.calls.delete(running) }
  }
  async #dispatch(method: FileMethod, params: FileMethods[FileMethod]["params"], data?: Uint8Array): Promise<FileReply<unknown>> {
    switch (method) {
      case "list": return { value: await this.#list((params as FileMethods["list"]["params"]).path) }
      case "stat": { const { path } = params as FileMethods["stat"]["params"]; return { value: await this.#entry(path, await this.#handle(path)) } }
      case "resolve": throw new Error("Agent resources belong to the executing machine")
      case "read": {
        const { path, offset, length, modifiedAt } = params as FileMethods["read"]["params"]
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > FILE_CHUNK_BYTES) throw new Error("Invalid file read")
        const handle = await this.#handle(path)
        if (handle.kind !== "file") throw new Error("A file is required")
        const file = await handle.getFile()
        if (modifiedAt !== undefined && file.lastModified !== modifiedAt) throw new Error("File changed during transfer")
        const data = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
        return { value: { bytes: data.byteLength }, data }
      }
      case "begin": {
        const request = params as FileMethods["begin"]["params"]
        if (segments(request.name).length !== 1) throw new Error("Invalid file name")
        const directory = await this.#directory(request.directory)
        let name = request.name
        const existing = await this.#exists(directory, name)
        if (existing && request.conflict === "skip") return { value: { transferId: "", skipped: true } }
        if (existing && request.conflict === "ask") throw conflict()
        if (existing && request.conflict === "rename") name = await this.#unusedName(directory, name, request.kind)
        else if (existing && (existing !== "file" || request.kind !== "file")) throw Object.assign(new Error("This browser cannot replace an existing folder. Keep both instead."), { code: "conflict" })
        const transferId = crypto.randomUUID()
        const stage = await (await navigator.storage.getDirectory()).getDirectoryHandle(`deskfleet-${transferId}`, { create: true }) as DirectoryHandle
        if (request.kind === "directory") await stage.getDirectoryHandle("directory", { create: true })
        this.#uploads.set(transferId, { directory, directoryPath: request.directory, requestedName: request.name, name, kind: request.kind, stage, files: new Map(), finished: new Set(), conflict: request.conflict, stop: new AbortController(), calls: new Set(), tail: Promise.resolve() })
        return { value: { transferId, skipped: false } }
      }
      case "mkdir": {
        const { transferId, path } = params as FileMethods["mkdir"]["params"]
        const upload = this.#upload(transferId)
        if (upload.kind !== "directory") throw new Error("A directory transfer is required")
        let directory = await upload.stage.getDirectoryHandle("directory", { create: true })
        for (const name of segments(path)) directory = await directory.getDirectoryHandle(name, { create: true })
        return { value: null }
      }
      case "write": {
        const { transferId, path, offset } = params as FileMethods["write"]["params"]
        const upload = this.#upload(transferId), filePath = this.#filePath(upload, path)
        if (!data || data.byteLength > FILE_CHUNK_BYTES || !Number.isSafeInteger(offset) || offset < 0 || upload.finished.has(filePath)) throw new Error("Invalid file write")
        let file = upload.files.get(filePath)
        if (!file) {
          if (offset !== 0) throw new Error("File writes must start at zero")
          const parent = await this.#parent(upload.stage, filePath, false)
          file = { stream: await (await parent.directory.getFileHandle(parent.name, { create: true })).createWritable(), offset: 0 }
          upload.files.set(filePath, file)
        }
        if (file.offset !== offset) throw new Error("File writes must be sequential")
        await file.stream.write(new Uint8Array(data).buffer)
        file.offset += data.byteLength
        return { value: { bytes: data.byteLength } }
      }
      case "finish": {
        const { transferId, path, size } = params as FileMethods["finish"]["params"]
        const upload = this.#upload(transferId), filePath = this.#filePath(upload, path), file = upload.files.get(filePath)
        if (!file || file.offset !== size) throw new Error("File size does not match the received bytes")
        await file.stream.close(); upload.files.delete(filePath); upload.finished.add(filePath)
        return { value: null }
      }
      case "commit": {
        const { transferId } = params as FileMethods["commit"]["params"]
        const upload = this.#upload(transferId)
        if (upload.files.size) throw new Error("Transfer has unfinished files")
        let existing = await this.#exists(upload.directory, upload.name)
        if (existing && upload.conflict === "skip") {
          const path = `${upload.directoryPath}/${upload.name}`
          await this.#remove(transferId)
          return { value: { path, skipped: true } }
        }
        if (existing && upload.conflict === "rename") {
          upload.name = await this.#unusedName(upload.directory, upload.requestedName, upload.kind)
          existing = null
        }
        if (existing && (upload.conflict !== "replace" || existing !== "file" || upload.kind !== "file")) throw conflict()
        try {
          upload.stop.signal.throwIfAborted()
          if (upload.kind === "file") {
            if (!upload.finished.has("file")) throw new Error("Transfer has no completed file")
            const destination = await upload.directory.getFileHandle(upload.name, { create: true })
            await this.#copyFile(await upload.stage.getFileHandle("file"), destination, upload.stop.signal)
          } else {
            const destination = await upload.directory.getDirectoryHandle(upload.name, { create: true }) as DirectoryHandle
            await this.#copyDirectory(await upload.stage.getDirectoryHandle("directory") as DirectoryHandle, destination, upload.stop.signal)
          }
        } catch (error) {
          // External directory handles have no atomic rename. Keep any committed
          // entries, including files another application may have created there.
          throw Object.assign(new Error("Copy did not finish. Files already saved in the destination have been kept.", { cause: error }), { code: "partial_copy" })
        }
        await this.#remove(transferId)
        return { value: { path: `${upload.directoryPath}/${upload.name}` } }
      }
      case "abort": await this.#abort((params as FileMethods["abort"]["params"]).transferId); return { value: null }
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    for (const upload of this.#uploads.values()) upload.stop.abort()
    await Promise.allSettled([...this.#calls])
    await Promise.all([...this.#uploads.keys()].map(id => this.#remove(id)))
    this.#roots.clear()
  }
}

/** Page/account lifetime, rather than the current machine view, owns browser transfers. */
export function createBrowserFiles(central: CentralApi): FilesApi & { close(): Promise<void> } {
  const listeners = new Set<(transfers: FileTransfer[]) => void>()
  const create = () => {
    const local = new BrowserFilesEndpoint()
    return new FileTransferManager({
      endpoint: async target => target.kind === "local" ? local : createBrowserFileEndpoint(central, target),
      chooseLocalDirectory: () => local.choose(),
    })
  }
  const publish = (transfers: FileTransfer[]) => { for (const listener of listeners) listener(transfers) }
  let manager = create()
  let unpublish = manager.onChanged(publish)
  const closing = new Set<Promise<void>>()
  const reset = () => {
    const previous = manager
    unpublish(); manager = create(); unpublish = manager.onChanged(publish)
    const pending = previous.close().catch(error => console.error("File transfer cleanup failed", error)).finally(() => { closing.delete(pending) })
    closing.add(pending)
    publish([])
  }
  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") reset()
  })
  const close = async () => {
    unsubscribe(); unpublish(); window.removeEventListener("pagehide", pagehide)
    await Promise.all([manager.close(), ...closing]); listeners.clear()
  }
  // Back/forward-cache pages can return with the same JS objects. Cancel access
  // while frozen, but leave the wrapper usable after the page is restored.
  const pagehide = (event: PageTransitionEvent) => { if (event.persisted) reset(); else void close() }
  window.addEventListener("pagehide", pagehide)
  return {
    list: (target, path) => manager.list(target, path),
    chooseLocalDirectory: () => manager.chooseLocalDirectory(),
    enqueue: request => manager.enqueue(request),
    transfers: () => manager.transfers(),
    cancel: id => manager.cancel(id), retry: (id, conflict) => manager.retry(id, conflict),
    resolveResource: request => manager.resolveResource(request),
    readResource: request => manager.readResource(request),
    saveResource: request => manager.saveResource(request),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    close,
  }
}
