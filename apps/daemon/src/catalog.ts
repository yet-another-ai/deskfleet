import { stat } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { isAbsolute, join } from "node:path"
import { openCatalog, type NativeCatalog } from "@deskfleet/native"
import type { CatalogDirectory, CatalogEvent, CatalogMethods, CatalogRequest } from "./catalog-protocol.ts"
import { ManagedSessionWorktrees } from "./session-worktrees.ts"

/** The daemon owns this machine's persistent catalog, independently of its clients. */
export class DaemonCatalog {
  readonly #directory: string
  readonly #listeners = new Set<(event: CatalogEvent) => void>()
  #catalog: NativeCatalog | undefined
  #sessions: ManagedSessionWorktrees | undefined

  constructor(directory: string) { this.#directory = directory }

  // Called only after this daemon has acquired its discovery record.
  async init(): Promise<void> {
    this.#catalog = await openCatalog(join(this.#directory, "catalog.db"), hostname())
    this.#sessions = new ManagedSessionWorktrees(this.#catalog, this.#directory)
  }

  onChange(listener: (event: CatalogEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async agentWorkingDirectory(worktreeId?: string): Promise<string> {
    if (worktreeId === undefined) return homedir()
    if (!this.#catalog) throw new Error("Local catalog is not available")
    const snapshot = await this.#catalog.snapshot()
    const worktree = snapshot.workspaces.flatMap(workspace => workspace.worktrees).find(worktree => worktree.id === worktreeId)
    const cwd = worktree?.directories[0]?.path
    if (!cwd) throw new Error("Unknown local worktree")
    return cwd
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
      case "workspaceSessionDestroy":
        await this.#sessions.destroy(request.params.sessionId)
        result = null
        break
    }
    for (const listener of this.#listeners) listener({ kind: "catalogChanged" })
    return result
  }

  async close(): Promise<void> {
    const catalog = this.#catalog
    this.#catalog = undefined
    this.#sessions = undefined
    this.#listeners.clear()
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
