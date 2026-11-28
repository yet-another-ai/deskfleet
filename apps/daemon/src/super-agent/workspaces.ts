import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { DaemonCatalog } from "../machine/catalog.ts"

export function isDefaultWorkerDirectory(registrationDirectory: string, path: string): boolean {
  const root = resolve(registrationDirectory, "super-agent-files")
  const directory = resolve(path)
  return directory === root || directory.startsWith(root + sep)
}

/** Machine-level MCP discovery and explicit IDs share the same project boundary. */
export async function machineMcpCatalog(catalog: DaemonCatalog) {
  const snapshot = await catalog.native.snapshot()
  const workspaces = snapshot.workspaces.filter(workspace => !workspace.worktrees.some(tree =>
    !tree.sessionId && tree.directories.some(entry => isDefaultWorkerDirectory(catalog.registrationDirectory, entry.path))))
  return { ...snapshot, workspaces }
}

/** Only an actual default-room Worker needs a catalog workspace and filesystem root. */
export function superWorkspaces(catalog: DaemonCatalog, registrationDirectory: string) {
  const privateRoot = resolve(registrationDirectory, "super-agent-files")
  let snapshot: ReturnType<DaemonCatalog["native"]["snapshot"]> | undefined
  catalog.onChange(() => { snapshot = undefined })
  function historyCatalog() {
    const read = snapshot ??= catalog.native.snapshot()
    void read.catch(() => { if (snapshot === read) snapshot = undefined })
    return read
  }
  const directoryFor = (userId: string) => join(privateRoot, createHash("sha256").update(userId).digest("hex"))
  const creating = new Map<string, Promise<string>>()
  async function workspaces(userId: string, includeDefaultWorker = false) {
    const { workspaces } = await catalog.native.snapshot()
    return workspaces.flatMap(({ id, name, worktrees }) => {
      const roots = worktrees.find(tree => !tree.sessionId)?.directories.map(entry => entry.path) ?? []
      if (!roots.length) return []
      const internal = roots.some(root => isDefaultWorkerDirectory(registrationDirectory, root))
      if (internal && !(includeDefaultWorker && roots.length === 1 && resolve(roots[0]!) === directoryFor(userId))) return []
      return [{ id, name, roots }]
    })
  }
  async function ensureDefaultWorkspace(userId: string): Promise<string> {
    const pending = creating.get(userId)
    if (pending) return pending
    const result = (async () => {
      const path = directoryFor(userId)
      const existing = (await workspaces(userId, true)).find(project => project.roots[0] === path)
      await mkdir(path, { recursive: true, mode: 0o700 })
      if (existing) return existing.id
      const workspace = await catalog.native.createWorkspace("Super Agent Files", [{ path }])
      catalog.changed()
      return workspace.id
    })()
    creating.set(userId, result)
    try { return await result } finally { creating.delete(userId) }
  }
  return { workspaces, ensureDefaultWorkspace, historyCatalog, historyChanged: () => catalog.changed() }
}
