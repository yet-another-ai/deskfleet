import { randomUUID } from "node:crypto"
import { lstat, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, posix, win32 } from "node:path"
import type { FileTarget } from "@deskfleet/client/files"
import { fileError, sessionResourcePath, uploadPath } from "../../../daemon/src/files-paths.ts"
import type { FileEndpoint, FileMethod, FileMethods, FileReply } from "../../../daemon/src/files-protocol.ts"
import { FilesService } from "../../../daemon/src/files-service.ts"

type LocalTarget = Extract<FileTarget, { kind: "local" }>
type Permission = "read" | "write"
interface Permissions { read: boolean; write: boolean; sessionId?: string }
interface Grant extends Permissions { root: string }
interface Upload { directory: string; name: string }

const denied = () => fileError("Choose a local folder to authorize file access", "file_grant_required")
const outside = () => fileError("File path is outside the authorized folder", "file_grant_path")

/** Validate path syntax independently of authorization, so realpath can resolve selected-root aliases. */
function absoluteGrantPath(value: string, platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix
  if (typeof value !== "string" || !value || value.includes("\0") || !paths.isAbsolute(value)) throw outside()
  if (platform === "win32") {
    const path = value.replaceAll("/", "\\")
    if (path.startsWith("\\\\?\\") || path.startsWith("\\\\.\\")) throw outside()
    if (!/^[a-z]:\\/iu.test(path) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(path)) throw outside()
    const tail = /^[a-z]:/iu.test(path) ? path.slice(2) : path
    if (tail.includes(":")) throw outside()
    const parts = tail.split("\\").filter(Boolean)
    if (parts.some(part => part !== "." && part !== ".." && (/[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))) throw outside()
  }
  return paths.resolve(value)
}

/** Lexical containment is used for canonical paths and new children of an authorized directory. */
export function grantedPath(root: string, value: string, platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix
  const path = absoluteGrantPath(value, platform), relative = paths.relative(root, path)
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw outside()
  return path
}

/** realpath supplies filesystem spelling; Windows can have case-sensitive directories. */
export function canonicalGrantedPath(root: string, value: string, platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix
  const path = grantedPath(root, value, platform)
  // Drive letters identify the same volume regardless of spelling. Directory components
  // must stay exact: win32.relative alone would conflate Project and project.
  const volumeCase = (path: string) => platform === "win32" ? path.replace(/^[a-z]:/iu, drive => drive.toUpperCase()) : path
  const canonicalRoot = volumeCase(paths.resolve(root)), canonical = volumeCase(path)
  const prefix = canonicalRoot.endsWith(paths.sep) ? canonicalRoot : `${canonicalRoot}${paths.sep}`
  if (canonical !== canonicalRoot && !canonical.startsWith(prefix)) throw outside()
  return path
}

/** One instance belongs to one window document and account epoch. Tokens never cross instances. */
export class FileGrants {
  readonly #grants = new Map<string, Grant>()
  readonly #endpoints = new Set<GrantedFilesEndpoint>()
  readonly #confirmOverwrite: (path: string) => Promise<boolean>
  #active = true

  constructor(options: { confirmOverwrite?(path: string): Promise<boolean> } = {}) {
    this.#confirmOverwrite = options.confirmOverwrite ?? (async () => false)
  }

  #checkActive(): void { if (!this.#active) throw denied() }
  #get(target: FileTarget): Grant {
    this.#checkActive()
    const grant = target.kind === "local" && target.grantId ? this.#grants.get(target.grantId) : undefined
    if (!grant) throw denied()
    return grant
  }

  /** Roots come from main-owned folder selection or captured daemon Session context, never renderer paths. */
  async issue(root: string, permissions: Permissions): Promise<LocalTarget> {
    this.#checkActive()
    absoluteGrantPath(root)
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw fileError("Select a folder", "invalid")
    this.#checkActive()
    const grantId = randomUUID()
    this.#grants.set(grantId, { ...permissions, root: canonical })
    return { kind: "local", grantId }
  }

  async assert(target: FileTarget, permission: Permission, path?: string): Promise<string> {
    const grant = this.#get(target)
    if (!grant[permission]) throw fileError(`This folder is not authorized for ${permission} access`, "file_grant_permission")
    const candidate = absoluteGrantPath(path ?? grant.root)
    // Reject roots/ancestors replaced by links and links which resolve outside the selected tree.
    if (await realpath(grant.root) !== grant.root) throw outside()
    const canonical = await realpath(candidate)
    canonicalGrantedPath(grant.root, canonical)
    this.#get(target)
    return canonical
  }

  async destination(target: FileTarget, directory: string, name: string): Promise<string> {
    const grant = this.#get(target)
    const parts = uploadPath(name)
    if (parts.length !== 1) throw fileError("Select one file or folder name", "invalid")
    const canonical = await this.assert(target, "write", directory)
    const path = grantedPath(grant.root, join(canonical, name))
    let exists = true
    try { await lstat(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error }
    if (exists) await this.assert(target, "write", path)
    this.#get(target)
    return path
  }

  async resolve(target: FileTarget, sessionId: string, uri: string): Promise<string> {
    const grant = this.#get(target)
    if (!grant.sessionId || grant.sessionId !== sessionId) throw fileError("Session preview requires its own folder authorization", "file_grant_session")
    const path = await sessionResourcePath(sessionId, uri, async () => grant.root)
    return this.assert(target, "read", path)
  }

  async overwrite(target: FileTarget, directory: string, name: string): Promise<void> {
    const path = await this.destination(target, directory, name)
    if (!await this.#confirmOverwrite(path)) throw fileError("Replacement was not authorized", "file_grant_overwrite")
    // A dialog may outlive its renderer document or account.
    await this.destination(target, directory, name)
  }

  endpoint(target: FileTarget): FileEndpoint {
    this.#get(target)
    const endpoint = new GrantedFilesEndpoint(this, { ...target } as LocalTarget)
    this.#endpoints.add(endpoint)
    return endpoint
  }

  revoke(): void { this.#active = false; this.#grants.clear() }
  async close(): Promise<void> {
    this.revoke()
    await Promise.all([...this.#endpoints].map(endpoint => endpoint.close()))
    this.#endpoints.clear()
  }
}

/**
 * Only the Electron local bridge uses this endpoint. Authorized remote daemons retain
 * their OS-user authority. Checks stop renderer-controlled escapes, including existing
 * symlinks/junctions; Node path-based I/O is not a race-safe sandbox against another
 * local process concurrently replacing filesystem entries between checks and use.
 */
class GrantedFilesEndpoint implements FileEndpoint {
  readonly #grants: FileGrants
  readonly #target: LocalTarget
  readonly #service = new FilesService()
  readonly #uploads = new Map<string, Upload>()
  #running: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(grants: FileGrants, target: LocalTarget) { this.#grants = grants; this.#target = target }

  call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    const next = this.#running.then(async () => {
      if (this.#closed) throw fileError("File connection is closed", "closed")
      if (!params || typeof params !== "object" || Array.isArray(params)) throw fileError("Invalid file request", "invalid")
      const result = await this.#call(method, params, data)
      // Do not deliver bytes/listings from a document or account that was revoked while awaiting I/O.
      await this.#grants.assert(this.#target, method === "list" || method === "stat" || method === "resolve" || method === "read" ? "read" : "write")
      return result
    })
    this.#running = next.catch(() => {})
    return next as Promise<FileReply<FileMethods[M]["result"]>>
  }

  async #call(method: FileMethod, params: FileMethods[FileMethod]["params"], data?: Uint8Array): Promise<FileReply<unknown>> {
    switch (method) {
      case "list": {
        const request = params as FileMethods["list"]["params"]
        const root = await this.#grants.assert(this.#target, "read")
        const path = await this.#grants.assert(this.#target, "read", request.path)
        const reply = await this.#service.call("list", { ...request, path })
        const entries = []
        for (const entry of reply.value.entries) {
          try { await this.#grants.assert(this.#target, "read", entry.path); entries.push(entry) }
          catch (error) { if (request.strict || (error as NodeJS.ErrnoException).code !== "file_grant_path") throw error }
        }
        return { value: { ...reply.value, entries, parentPath: path === root ? null : dirname(path), homePath: root, roots: [{ name: basename(root) || root, path: root }], grantId: this.#target.grantId } }
      }
      case "stat": {
        const path = await this.#grants.assert(this.#target, "read", (params as FileMethods["stat"]["params"]).path)
        const reply = await this.#service.call("stat", { path })
        await this.#grants.assert(this.#target, "read", reply.value.path)
        return reply
      }
      case "resolve": {
        const request = params as FileMethods["resolve"]["params"]
        const path = await this.#grants.resolve(this.#target, request.sessionId, request.uri)
        const reply = await this.#service.call("stat", { path })
        await this.#grants.assert(this.#target, "read", reply.value.path)
        return reply
      }
      case "read": {
        const request = params as FileMethods["read"]["params"]
        const path = await this.#grants.assert(this.#target, "read", request.path)
        return this.#service.call("read", { ...request, path })
      }
      case "begin": {
        const request = params as FileMethods["begin"]["params"]
        const directory = await this.#grants.assert(this.#target, "write", request.directory)
        await this.#grants.destination(this.#target, directory, request.name)
        if (request.conflict === "replace") await this.#grants.overwrite(this.#target, directory, request.name)
        const reply = await this.#service.call("begin", { ...request, directory })
        if (reply.value.transferId) this.#uploads.set(reply.value.transferId, { directory, name: request.name })
        return reply
      }
      case "mkdir": case "write": case "finish": case "commit": case "abort": {
        const request = params as FileMethods["commit"]["params"]
        const upload = this.#uploads.get(request.transferId)
        if (!upload) throw fileError("Transfer was not authorized by this folder grant", "file_grant_transfer")
        await this.#grants.destination(this.#target, upload.directory, upload.name)
        const reply = await this.#service.call(method, params as never, data)
        if (method === "commit" || method === "abort") this.#uploads.delete(request.transferId)
        return reply
      }
      default: throw fileError("Unknown file operation", "invalid")
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#running
    await this.#service.close()
    this.#uploads.clear()
  }
}
