import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { CatalogDirectory, CatalogSnapshot, CatalogWorktree, CatalogWorkspaceSession } from "@deskfleet/native"

const execute = promisify(execFile)

export interface ManagedSessionCatalog {
  snapshot(): Promise<CatalogSnapshot>
  createWorkspaceSession(workspaceId: string): Promise<CatalogWorkspaceSession>
  attachSessionWorktree(sessionId: string, directories: CatalogDirectory[]): Promise<CatalogWorktree>
  deleteWorkspaceSession(sessionId: string): Promise<void>
}

export interface ManagedWorkspaceSession extends CatalogWorkspaceSession {
  worktree: CatalogWorktree
}

interface SourceDirectory {
  repository: string
  revision: string
  relativePath: string
}
interface OwnedWorktree { path: string; repository: string }
interface Manifest { sessionId: string; directory?: string; worktrees: OwnedWorktree[] }

interface WorktreeStorage {
  originId: string
  root(): Promise<string | null>
}

async function git(args: string[]): Promise<string> {
  return (await execute("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.replace(/\r?\n$/u, "")
}

/** Git for Windows prints worktree paths with forward slashes and its own casing. */
function pathsMatch(left: string, right: string): boolean {
  if (process.platform !== "win32") return left === right
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase()
}

async function sourceDirectory(path: string): Promise<SourceDirectory> {
  const directory = await realpath(path)
  let root: string
  let repository: string
  let revision: string
  try {
    root = await realpath(await git(["-C", directory, "rev-parse", "--show-toplevel"]))
    repository = await realpath(await git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
    revision = await git(["-C", root, "rev-parse", "--verify", "HEAD"])
  } catch (error) {
    throw new Error(`Cannot isolate ${path}: a Git working tree with a committed HEAD is required`, { cause: error })
  }
  const relativePath = relative(root, directory)
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Directory is outside its Git worktree: ${path}`)
  }
  return { repository, revision, relativePath }
}

/** Temporary Git checkouts belong to a workspace Session, independently of clients. */
export class ManagedSessionWorktrees {
  readonly #catalog: ManagedSessionCatalog
  readonly #directory: string
  readonly #storage: WorktreeStorage | undefined
  readonly #destroying = new Map<string, Promise<void>>()

  constructor(catalog: ManagedSessionCatalog, directory: string, storage?: WorktreeStorage) {
    this.#catalog = catalog
    this.#directory = resolve(directory, "session-worktrees")
    this.#storage = storage
  }

  async create(workspaceId: string, allocated?: CatalogWorkspaceSession): Promise<ManagedWorkspaceSession> {
    const workspace = (await this.#catalog.snapshot()).workspaces.find(value => value.id === workspaceId)
    const main = workspace?.worktrees.find(worktree => !worktree.sessionId)
    if (!main || main.directories.length === 0) throw new Error("Workspace has no main directories")
    // Resolve all sources before allocating anything; non-Git workspaces remain
    // usable for terminals but cannot supply isolated agent sessions.
    const sources: SourceDirectory[] = []
    for (const directory of main.directories) sources.push(await sourceDirectory(directory.path))
    // A settings change affects the next Session, never an in-flight creation.
    const root = await this.#storage?.root()
    const physicalRoot = root ? await realpath(root) : undefined
    if (physicalRoot && !(await stat(physicalRoot)).isDirectory()) throw new Error("Worktree root must be a directory")
    if (allocated && allocated.workspaceId !== workspaceId) throw new Error("Session belongs to a different workspace")
    const session = allocated ?? await this.#catalog.createWorkspaceSession(workspaceId)
    const directory = this.#sessionDirectory(session.id)
    const manifest: Manifest = { sessionId: session.id, worktrees: [] }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      let physicalDirectory = await realpath(directory)
      if (physicalRoot) {
        const parent = join(physicalRoot, this.#storage!.originId)
        await mkdir(parent, { recursive: true, mode: 0o700 })
        const target = join(await realpath(parent), session.id)
        this.#checkStorageDirectory(target, session.id)
        // Do not take ownership of an existing directory in a shared root.
        await mkdir(target, { mode: 0o700 })
        manifest.directory = target
        physicalDirectory = target
        await this.#save(manifest)
      }
      const groups = new Map<string, string>()
      const directories: CatalogDirectory[] = []
      for (const source of sources) {
        const key = `${source.repository}\0${source.revision}`
        let target = groups.get(key)
        if (!target) {
          target = join(physicalDirectory, `repo-${manifest.worktrees.length}`)
          manifest.worktrees.push({ path: target, repository: source.repository })
          // Persist ownership before Git creates files so interrupted creation
          // can be explicitly destroyed after a daemon restart.
          await this.#save(manifest)
          await git(["--git-dir", source.repository, "worktree", "add", "--detach", target, source.revision])
          groups.set(key, target)
        }
        const path = join(target, source.relativePath)
        if (!(await stat(path)).isDirectory()) throw new Error(`Session directory is not present in the committed Git tree: ${path}`)
        directories.push({ path })
      }
      const worktree = await this.#catalog.attachSessionWorktree(session.id, directories)
      return { ...session, worktree }
    } catch (error) {
      try {
        await this.#removeOwned(manifest)
        if (!allocated) await this.#catalog.deleteWorkspaceSession(session.id)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `Session ${session.id} creation failed and cleanup is incomplete`, { cause: error })
      }
      throw error
    }
  }

  /**
   * Records the Workspace's current directories as the Session's execution
   * context without generating checkouts; the agent works in those directories.
   */
  async useDirectories(allocated: CatalogWorkspaceSession): Promise<ManagedWorkspaceSession> {
    const workspace = (await this.#catalog.snapshot()).workspaces.find(value => value.id === allocated.workspaceId)
    const main = workspace?.worktrees.find(worktree => !worktree.sessionId)
    if (!main || main.directories.length === 0) throw new Error("Workspace has no main directories")
    for (const { path } of main.directories) {
      let info
      try { info = await stat(path) }
      catch (error) { throw new Error(`Cannot access directory: ${path}`, { cause: error }) }
      if (!info.isDirectory()) throw new Error(`Not a directory: ${path}`)
    }
    const worktree = await this.#catalog.attachSessionWorktree(allocated.id, main.directories.map(({ path }) => ({ path })))
    return { ...allocated, worktree }
  }

  destroy(sessionId: string): Promise<void> {
    const pending = this.#destroying.get(sessionId)
    if (pending) return pending
    const removing = this.#destroy(sessionId).finally(() => this.#destroying.delete(sessionId))
    this.#destroying.set(sessionId, removing)
    return removing
  }

  async #destroy(sessionId: string): Promise<void> {
    const directory = this.#sessionDirectory(sessionId)
    let manifest: Manifest
    try { manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // A Session using Workspace directories in place owns no files. A process
      // may also stop after allocating a session but before creating files.
      await this.#catalog.deleteWorkspaceSession(sessionId)
      return
    }
    if (manifest.sessionId !== sessionId || !Array.isArray(manifest.worktrees)) throw new Error("Invalid session worktree ownership manifest")
    const physicalDirectory = manifest.directory ?? await realpath(directory)
    if (manifest.directory !== undefined) this.#checkStorageDirectory(manifest.directory, sessionId)
    for (const [index, worktree] of manifest.worktrees.entries()) {
      if (!worktree || worktree.path !== join(physicalDirectory, `repo-${index}`) || typeof worktree.repository !== "string" || !isAbsolute(worktree.repository)) {
        throw new Error("Invalid session worktree ownership manifest")
      }
    }
    await this.#removeOwned(manifest)
    await this.#catalog.deleteWorkspaceSession(sessionId)
  }

  #sessionDirectory(sessionId: string): string {
    if (!/^[1-9][0-9]*$/u.test(sessionId)) throw new Error("Invalid workspace session ID")
    return join(this.#directory, sessionId)
  }

  #checkStorageDirectory(directory: string, sessionId: string): void {
    if (!this.#storage || typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory
      || basename(directory) !== sessionId || basename(dirname(directory)) !== this.#storage.originId) {
      throw new Error("Invalid session worktree ownership manifest")
    }
  }

  async #save(manifest: Manifest): Promise<void> {
    const directory = this.#sessionDirectory(manifest.sessionId)
    const temporary = join(directory, "manifest.tmp")
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 })
    await rename(temporary, join(directory, "manifest.json"))
  }

  async #removeOwned(manifest: Manifest): Promise<void> {
    // Remove from the end, preserving positional ownership names on retries.
    while (manifest.worktrees.length) {
      const worktree = manifest.worktrees[manifest.worktrees.length - 1]!
      const registered = (await git(["--git-dir", worktree.repository, "worktree", "list", "--porcelain", "-z"]))
        .split("\0").some(record => record.startsWith("worktree ") && pathsMatch(record.slice("worktree ".length), worktree.path))
      if (registered) await git(["--git-dir", worktree.repository, "worktree", "remove", "--force", worktree.path])
      else await rm(worktree.path, { recursive: true, force: true })
      manifest.worktrees.pop()
      await this.#save(manifest)
    }
    if (manifest.directory) await rm(manifest.directory, { recursive: true, force: true })
    await rm(this.#sessionDirectory(manifest.sessionId), { recursive: true, force: true })
  }
}
