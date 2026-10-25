import { randomUUID } from "node:crypto"
import { link, mkdir, mkdtemp, open, rename, rm, rmdir, type FileHandle } from "node:fs/promises"
import { extname, join } from "node:path"
import { FILE_CHUNK_BYTES, type FileConflict, type FileKind, type FileMethods } from "./files-protocol.ts"
import { directoryPath, exists, fileError, text, uploadPath, whole } from "./files-paths.ts"

interface UploadFile { handle?: FileHandle; bytes: number; finished: boolean }
interface Upload {
  directory: string; name: string; kind: FileKind; conflict: FileConflict
  staging: string; root: string; files: Map<string, UploadFile>; directories: Set<string>
}

const conflicting = (error: unknown) => ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")

/** Publish without replacing an entry another transfer created after begin. */
async function publish(upload: Upload, path: string): Promise<void> {
  if (upload.kind === "file") { await link(upload.root, path); return }
  if (process.platform === "win32") {
    // libuv uses MoveFileExW, which cannot replace an existing directory.
    // Unlike POSIX rename, it needs no empty destination reservation.
    try { await rename(upload.root, path) }
    catch (error) {
      if (await exists(path)) throw fileError("Destination already exists", "EEXIST")
      throw error
    }
    return
  }
  await mkdir(path)
  try { await rename(upload.root, path) }
  catch (error) {
    // Never recursively remove a reservation: another process may have added files.
    await rmdir(path).catch(() => {})
    throw error
  }
}

/** Staging belongs to one endpoint; close and abort remove only its unfinished work. */
export class FileUploads {
  readonly #uploads = new Map<string, Upload>()

  async begin(params: FileMethods["begin"]["params"]): Promise<FileMethods["begin"]["result"]> {
    const directory = await directoryPath(params.directory)
    const parts = uploadPath(params.name)
    if (parts.length !== 1) throw fileError("Select one file or folder name", "invalid")
    if (params.kind !== "file" && params.kind !== "directory") throw fileError("Invalid file kind", "invalid")
    if (!["ask", "replace", "rename", "skip"].includes(params.conflict)) throw fileError("Invalid conflict policy", "invalid")
    if (this.#uploads.size >= 32) throw fileError("Too many active transfers", "busy")
    const name = parts[0]!
    if (await exists(join(directory, name))) {
      if (params.conflict === "ask") throw fileError("An item with this name already exists", "conflict")
      if (params.conflict === "skip") return { transferId: "", skipped: true }
    }
    const staging = await mkdtemp(join(directory, ".deskfleet-transfer-"))
    const root = join(staging, "content")
    try { if (params.kind === "directory") await mkdir(root) }
    catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
    const transferId = randomUUID()
    this.#uploads.set(transferId, { directory, name, kind: params.kind, conflict: params.conflict, staging, root, files: new Map(), directories: new Set([""]) })
    return { transferId, skipped: false }
  }

  #get(id: unknown): Upload {
    const upload = this.#uploads.get(text(id, "transfer ID"))
    if (!upload) throw fileError("Transfer was not found", "not_found")
    return upload
  }

  #path(upload: Upload, value: unknown): { key: string; path: string; parent: string } {
    const parts = uploadPath(value)
    if (upload.kind === "file" && parts.length) throw fileError("A file transfer has no child paths", "invalid")
    const key = parts.join("/")
    return { key, path: join(upload.root, ...parts), parent: parts.slice(0, -1).join("/") }
  }

  async mkdir(params: FileMethods["mkdir"]["params"]): Promise<null> {
    const upload = this.#get(params.transferId)
    if (upload.kind !== "directory") throw fileError("Transfer is not a directory", "invalid")
    const { key, path, parent } = this.#path(upload, params.path)
    if (upload.directories.has(key)) return null
    if (!upload.directories.has(parent)) throw fileError("Create the parent directory first", "invalid")
    await mkdir(path)
    upload.directories.add(key)
    return null
  }

  async #file(upload: Upload, relative: unknown): Promise<UploadFile> {
    const { key, path, parent } = this.#path(upload, relative)
    if (upload.kind === "directory" && !key) throw fileError("File requires a child path", "invalid")
    if (!upload.directories.has(parent)) throw fileError("Create the parent directory first", "invalid")
    let file = upload.files.get(key)
    if (!file) {
      if ([...upload.files.values()].filter(value => value.handle).length >= 64) throw fileError("Finish open files before starting more", "busy")
      file = { handle: await open(path, "wx", 0o600), bytes: 0, finished: false }
      upload.files.set(key, file)
    }
    return file
  }

  async write(params: FileMethods["write"]["params"], data?: Uint8Array): Promise<{ bytes: number }> {
    const upload = this.#get(params.transferId)
    const offset = whole(params.offset, "write offset")
    if (!data || data.byteLength > FILE_CHUNK_BYTES) throw fileError("Invalid file chunk size", "invalid")
    const file = await this.#file(upload, params.path)
    if (file.finished || !file.handle) throw fileError("File has already finished", "invalid")
    if (offset !== file.bytes || !Number.isSafeInteger(offset + data.byteLength)) throw fileError("File chunk has an unexpected offset", "invalid")
    let written = 0
    while (written < data.byteLength) {
      const { bytesWritten } = await file.handle.write(data, written, data.byteLength - written, offset + written)
      if (!bytesWritten) throw fileError("Could not write file data")
      written += bytesWritten
      file.bytes += bytesWritten
    }
    return { bytes: written }
  }

  async finish(params: FileMethods["finish"]["params"]): Promise<null> {
    const size = whole(params.size, "file size")
    const file = await this.#file(this.#get(params.transferId), params.path)
    if (file.bytes !== size) throw fileError("File size does not match received data", "invalid")
    await file.handle?.close()
    file.handle = undefined
    file.finished = true
    return null
  }

  async commit(params: FileMethods["commit"]["params"]): Promise<FileMethods["commit"]["result"]> {
    const upload = this.#get(params.transferId)
    if ((upload.kind === "file" && !upload.files.has("")) || [...upload.files.values()].some(file => !file.finished)) {
      throw fileError("Finish all files before completing the transfer", "invalid")
    }
    let path = join(upload.directory, upload.name)
    if (upload.conflict === "replace") {
      const backup = join(upload.staging, "previous")
      let replaced = false
      if (await exists(path)) { await rename(path, backup); replaced = true }
      try { await rename(upload.root, path) }
      catch (error) {
        if (replaced) {
          try { await rename(backup, path) }
          catch (restoreError) {
            // The previous user data is still here. Neither the caller's abort
            // nor peer shutdown may treat this directory as disposable staging.
            this.#uploads.delete(params.transferId)
            throw Object.assign(new Error(`Replacement failed and the original item could not be restored. Recover it from ${backup}`, {
              cause: new AggregateError([error, restoreError], "Replacement and rollback failed"),
            }), { code: "recovery_required" })
          }
        }
        throw error
      }
    } else {
      const extension = upload.kind === "file" ? extname(upload.name) : ""
      const stem = extension ? upload.name.slice(0, -extension.length) : upload.name
      for (let index = 0; ; index++) {
        if (index) path = join(upload.directory, `${stem} (${index})${extension}`)
        try { await publish(upload, path); break }
        catch (error) {
          if (!conflicting(error)) throw error
          if (upload.conflict === "rename") continue
          if (upload.conflict === "skip") { await this.abort(params); return { path, skipped: true } }
          throw fileError("An item with this name already exists", "conflict")
        }
      }
    }
    this.#uploads.delete(params.transferId)
    await rm(upload.staging, { recursive: true, force: true })
    return { path }
  }

  async abort(params: FileMethods["abort"]["params"]): Promise<null> {
    const id = text(params.transferId, "transfer ID")
    const upload = this.#uploads.get(id)
    if (!upload) return null
    this.#uploads.delete(id)
    await Promise.all([...upload.files.values()].map(file => file.handle?.close()))
    await rm(upload.staging, { recursive: true, force: true })
    return null
  }

  async close(): Promise<void> { await Promise.all([...this.#uploads.keys()].map(transferId => this.abort({ transferId }))) }
}
