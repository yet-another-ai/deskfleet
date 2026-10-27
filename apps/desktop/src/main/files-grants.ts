import { randomUUID } from "node:crypto"
import { lstat, mkdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, posix, win32 } from "node:path"
import type { FileTarget } from "@deskfleet/client/files"
import { defaultDirectory, fileError, sessionResourcePath, uploadPath } from "../../../daemon/src/files-paths.ts"
import type { FileEndpoint, FileMethod, FileMethods, FileReply } from "../../../daemon/src/files-protocol.ts"
import { FilesService } from "../../../daemon/src/files-service.ts"

type LocalTarget = Extract<FileTarget, { kind: "local" }>
type Permission = "read" | "write"
interface Permissions { read: boolean; write: boolean; sessionId?: string; additionalRoots?: string[] }
interface Grant extends Permissions { root: string; scope: "folder" | "filesystem"; additionalRoots: string[] }
interface Upload { directory: string; name: string }

const denied = () => fileError("Local file access has expired; reopen the file transfer panel", "file_grant_required")
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
  readonly #sessionAttachmentDirectory?: (sessionId: string) => Promise<string>
  #active = true

  constructor(options: { confirmOverwrite?(path: string): Promise<boolean>; sessionAttachmentDirectory?(sessionId: string): Promise<string> } = {}) {
    this.#confirmOverwrite = options.confirmOverwrite ?? (async () => false)
    this.#sessionAttachmentDirectory = options.sessionAttachmentDirectory
  }

  #checkActive(): void { if (!this.#active) throw denied() }
  #get(target: FileTarget): Grant {
    this.#checkActive()
    const grant = target.kind === "local" && target.grantId ? this.#grants.get(target.grantId) : undefined
    if (!grant) throw denied()
    return grant
  }

  /** Session preview roots come from captured daemon context, never renderer paths. */
  async issue(root: string, permissions: Permissions): Promise<LocalTarget> {
    return this.#issue(root, permissions, "folder")
  }

  /** Desktop transfers use the hosting process's OS access without a folder consent step. */
  async issueLocal(): Promise<LocalTarget> {
    return this.#issue(defaultDirectory(), { read: true, write: true }, "filesystem")
  }

  async #issue(root: string, permissions: Permissions, scope: Grant["scope"]): Promise<LocalTarget> {
    this.#checkActive()
    absoluteGrantPath(root)
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw fileError("Select a folder", "invalid")
    const additionalRoots: string[] = []
    for (const extra of permissions.additionalRoots ?? []) {
      const candidate = absoluteGrantPath(extra)
      const resolved = await realpath(candidate).catch(() => candidate)
      additionalRoots.push(resolved)
    }
    this.#checkActive()
    const grantId = randomUUID()
    this.#grants.set(grantId, { ...permissions, root: canonical, scope, additionalRoots })
    return { kind: "local", grantId }
  }

  async assert(target: FileTarget, permission: Permission, path?: string): Promise<string> {
    const grant = this.#get(target)
    if (!grant[permission]) throw fileError(`This folder is not authorized for ${permission} access`, "file_grant_permission")
    const candidate = absoluteGrantPath(path ?? grant.root)
    // Session previews stay in their captured tree; transfers follow OS filesystem access.
    if (grant.scope === "folder" && await realpath(grant.root) !== grant.root) throw outside()
    const canonical = await realpath(candidate)
    if (grant.scope === "folder") {
      const roots = [grant.root]
      for (const extra of grant.additionalRoots) {
        roots.push(await realpath(extra).catch(() => extra))
      }
      const allowed = roots.some(root => {
        try { canonicalGrantedPath(root, canonical); return true }
        catch { return false }
      })
      if (!allowed) throw outside()
    }
    this.#get(target)
    return canonical
  }

  async destination(target: FileTarget, directory: string, name: string): Promise<string> {
    const grant = this.#get(target)
    const parts = uploadPath(name)
    if (parts.length !== 1) throw fileError("Select one file or folder name", "invalid")
    const canonical = await this.assert(target, "write", directory)
    const path = grant.scope === "folder" ? grantedPath(grant.root, join(canonical, name)) : absoluteGrantPath(join(canonical, name))
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
    const grant = this.#get(target)
    const endpoint = new GrantedFilesEndpoint(this, { ...target } as LocalTarget, grant.scope, this.#sessionAttachmentDirectory)
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
 * The Electron local bridge owns this endpoint for one document/account. Transfers
 * use OS-user access; Session previews remain read-only and confined to their root.
 * Folder checks are not a race-safe sandbox against concurrent filesystem changes.
 */
class GrantedFilesEndpoint implements FileEndpoint {
  readonly #grants: FileGrants
  readonly #target: LocalTarget
  readonly #scope: Grant["scope"]
  readonly #service: FilesService
  readonly #sessionAttachmentDirectory?: (sessionId: string) => Promise<string>
  readonly #uploads = new Map<string, Upload>()
  #running: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(
    grants: FileGrants,
    target: LocalTarget,
    scope: Grant["scope"],
    sessionAttachmentDirectory?: (sessionId: string) => Promise<string>,
  ) {
    this.#grants = grants
    this.#target = target
    this.#scope = scope
    this.#sessionAttachmentDirectory = sessionAttachmentDirectory
    this.#service = new FilesService(undefined, sessionAttachmentDirectory)
  }

  call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    const next = this.#running.then(async () => {
      if (this.#closed) throw fileError("File connection is closed", "closed")
      if (!params || typeof params !== "object" || Array.isArray(params)) throw fileError("Invalid file request", "invalid")
      const result = await this.#call(method, params, data)
      // Do not deliver bytes/listings from a document or account that was revoked while awaiting I/O.
      await this.#grants.assert(this.#target, ["list", "stat", "resolve", "openRead", "read", "closeRead"].includes(method) ? "read" : "write")
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
        if (this.#scope === "filesystem") return reply
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
      case "openRead": {
        const request = params as FileMethods["openRead"]["params"]
        const path = await this.#grants.assert(this.#target, "read", request.path)
        return this.#service.call("openRead", { ...request, path })
      }
      case "closeRead": {
        await this.#grants.assert(this.#target, "read")
        return this.#service.call("closeRead", params as FileMethods["closeRead"]["params"])
      }
      case "read": {
        const request = params as FileMethods["read"]["params"]
        const path = await this.#grants.assert(this.#target, "read", request.path)
        return this.#service.call("read", { ...request, path })
      }
      case "begin": {
        const request = params as FileMethods["begin"]["params"]
        let rawDirectory = request.directory
        if (!rawDirectory && request.sessionId && this.#sessionAttachmentDirectory) {
          rawDirectory = await this.#sessionAttachmentDirectory(request.sessionId)
          await mkdir(rawDirectory, { recursive: true, mode: 0o700 })
        }
        const directory = await this.#grants.assert(this.#target, "write", rawDirectory)
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
