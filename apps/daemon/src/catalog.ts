import { stat } from "node:fs/promises"
import { hostname } from "node:os"
import { isAbsolute, join } from "node:path"
import { openCatalog, type NativeCatalog } from "@deskfleet/native"
import type { AgentSessionContext } from "./agent-protocol.ts"
import type { CatalogDirectory, CatalogEvent, CatalogMethods, CatalogRequest } from "./catalog-protocol.ts"
import { ManagedSessionWorktrees } from "./session-worktrees.ts"
import { readWorktreeRoot } from "./worktree-settings.ts"

/** The daemon owns this machine's persistent catalog, independently of its clients. */
export class DaemonCatalog {
  readonly #directory: string
  readonly #hostDirectory: string
  readonly #listeners = new Set<(event: CatalogEvent) => void>()
  readonly #releasing = new Set<(worktreeId: string) => Promise<void>>()
  #catalog: NativeCatalog | undefined
  #sessions: ManagedSessionWorktrees | undefined

  constructor(directory: string, hostDirectory = directory) { this.#directory = directory; this.#hostDirectory = hostDirectory }

  // Called only after this daemon has acquired its discovery record.
  async init(): Promise<void> {
    this.#catalog = await openCatalog(join(this.#directory, "catalog.db"), hostname())
    const { originId } = JSON.parse(await this.#catalog.agentIdentity()) as { originId: string }
    this.#sessions = new ManagedSessionWorktrees(this.#catalog, this.#directory, {
      originId, root: () => readWorktreeRoot(this.#hostDirectory),
    })
  }

  onChange(listener: (event: CatalogEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Resources owned by a Session's Worktree, such as its terminals, end before the Worktree is removed. */
  onSessionRelease(listener: (worktreeId: string) => Promise<void>): () => void {
    this.#releasing.add(listener)
    return () => this.#releasing.delete(listener)
  }

  /** The Worktree a Session owns, if its context was provisioned. */
  async sessionWorktree(sessionId: string) {
    return (await this.native.snapshot()).workspaces.flatMap(workspace => workspace.worktrees).find(worktree => worktree.sessionId === sessionId)
  }

  get native(): NativeCatalog {
    if (!this.#catalog) throw new Error("Local catalog is not available")
    return this.#catalog
  }

  async provisionSession(id: string, workspaceId: string, context: AgentSessionContext): Promise<void> {
    if (!this.#sessions) throw new Error("Local catalog is not available")
    if (context === "directory") await this.#sessions.useDirectories({ id, workspaceId })
    else await this.#sessions.create(workspaceId, { id, workspaceId })
    this.changed()
  }

  changed(): void {
    for (const listener of this.#listeners) listener({ kind: "catalogChanged" })
  }

  async handle(request: CatalogRequest): Promise<CatalogMethods[keyof CatalogMethods]["result"]> {
    const catalog = this.#catalog
    if (!catalog || !this.#sessions) throw new Error("Local catalog is not available")
    let result: CatalogMethods[keyof CatalogMethods]["result"]
    switch (request.method) {
      case "catalogList":
        return catalog.snapshot()
      case "workspaceCreate":
        await checkDirectories(request.params.directories)
        result = await catalog.createWorkspace(request.params.name, request.params.directories)
        break
      case "workspaceUpdate":
        await checkDirectories(request.params.directories)
        result = await catalog.updateWorkspace(request.params.workspaceId, request.params.name, request.params.directories)
        break
      case "workspaceDelete":
        await catalog.deleteWorkspace(request.params.workspaceId)
        result = null
        break
      case "workspaceSessionCreate":
        result = await this.#sessions.create(request.params.workspaceId)
        break
      case "workspaceSessionDestroy": {
        const worktree = await this.sessionWorktree(request.params.sessionId)
        if (worktree) for (const release of this.#releasing) await release(worktree.id)
        await this.#sessions.destroy(request.params.sessionId)
        result = null
        break
      }
    }
    this.changed()
    return result
  }

  async close(): Promise<void> {
    const catalog = this.#catalog
    this.#catalog = undefined
    this.#sessions = undefined
    this.#listeners.clear()
    this.#releasing.clear()
    await catalog?.close()
  }
}

async function checkDirectories(directories: CatalogDirectory[]): Promise<void> {
  for (const directory of directories) {
    if (!isAbsolute(directory.path)) throw new Error(`Directory must use an absolute path: ${directory.path}`)
    let info
    try { info = await stat(directory.path) }
    catch (error) {
      throw new Error(`Cannot access directory: ${directory.path}`, { cause: error })
    }
    if (!info.isDirectory()) throw new Error(`Not a directory: ${directory.path}`)
  }
}
