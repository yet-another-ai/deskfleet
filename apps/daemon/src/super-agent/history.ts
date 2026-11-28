import { resolve } from "node:path"
import type { CatalogSnapshot } from "@deskfleet/native"
import type { AgentActor, AgentSessionRecord } from "@deskfleet/protocol/agent"
import { superRequestObject, superResourceId, type SuperHistory, type SuperHistoryGroup } from "@deskfleet/protocol/super-agent"
import { emptyState, type SuperStateStore } from "./state.ts"
import { ownedByActor } from "./target.ts"
import type { SuperWorkers } from "./worker.ts"
import type { SuperWorkspace } from "@deskfleet/protocol/super-agent"

interface HistorySource {
  agents: SuperWorkers
  store: SuperStateStore
  historyCatalog?: () => Promise<CatalogSnapshot>
  historyChanged?: () => void
  workspaces: (userId: string) => Promise<SuperWorkspace[]>
}

const directoryKey = (paths: string[]) => JSON.stringify(paths.map(path => resolve(path)))

function ownership(catalog: CatalogSnapshot, links: Record<string, string> = {}) {
  const owners = new Map<string, string>()
  const roots = new Map<string, string>()
  for (const project of catalog.workspaces) {
    for (const tree of project.worktrees) {
      if (tree.sessionId) owners.set(tree.sessionId, project.id)
      else roots.set(project.id, directoryKey(tree.directories.map(d => d.path)))
    }
  }
  const linked = new Map<string, string>()
  for (const tree of catalog.sessions) {
    if (!tree.sessionId || owners.has(tree.sessionId)) continue
    const id = Object.hasOwn(links, tree.sessionId) ? links[tree.sessionId] : undefined
    if (id && roots.get(id) === directoryKey(tree.directories.map(d => d.path))) linked.set(tree.sessionId, id)
  }
  return { owners, linked }
}

/** Only the project agent sees the personal directory links. Original worker records and commands stay in the journal. */
export async function projectWorkers(source: HistorySource, uid: string): Promise<SuperWorkers> {
  const workers = source.agents
  if (!source.historyCatalog) return workers
  const { owners, linked } = ownership(await source.historyCatalog(), source.store.get(uid)?.historyProjects)
  if (!owners.size && !linked.size) return workers
  function session(record: AgentSessionRecord): AgentSessionRecord {
    const workspaceId = owners.get(record.id) ?? linked.get(record.id)
    return record.workspaceId || !workspaceId ? record : { ...record, workspaceId }
  }
  const journal = workers.journal
  return {
    handle: workers.handle.bind(workers), onEvent: workers.onEvent.bind(workers),
    journal: {
      command: journal.command.bind(journal), commands: journal.commands.bind(journal), history: journal.history.bind(journal),
      async list() { return (await journal.list()).map(session) },
      async read(id) { const snapshot = await journal.read(id); return { ...snapshot, session: session(snapshot.session) } },
    },
  }
}

export async function organizeHistory(source: HistorySource, actor: AgentActor, value: unknown): Promise<SuperHistory> {
  if (actor.kind !== "user" || !actor.userId || !actor.deviceId || !source.historyCatalog) throw new Error("History organization is unavailable")
  const uid = actor.userId
  const request = superRequestObject(value)
  const catalog = await source.historyCatalog()
  const links = () => ownership(catalog, source.store.get(uid)?.historyProjects)
  const { owners, linked } = links()
  if (request.view === "links" && request.assign === undefined) return { links: Object.fromEntries(linked) }
  if (request.view !== "groups") throw new Error("Unknown history view")
  const projects = await source.workspaces(uid)
  const sessions = new Map((await source.agents.journal.list()).map(session => [session.id, session]))
  const groups = new Map<string, SuperHistoryGroup>()
  const assign = request.assign === undefined ? undefined : superRequestObject(request.assign)
  const projectId = assign && superResourceId(assign.workspaceId)
  const project = projects.find(candidate => candidate.id === projectId)
  const targetDirectory = project && directoryKey(project.roots)
  if (assign && (!project || !Array.isArray(assign.sessionIds) || !assign.sessionIds.length)) throw new Error("Choose an available project and directory group")
  const requested = new Set<string>(assign ? (assign.sessionIds as unknown[]).map(superResourceId) : [])
  const eligible = new Set<string>()
  for (const tree of catalog.sessions) {
    const id = tree.sessionId
    if (!id || owners.has(id) || !tree.directories.length) continue
    const existing = linked.get(id)
    if (existing && !requested.has(id)) continue
    const session = sessions.get(id)
    if (!session || session.workspaceId || session.context !== "directory" || session.archiveState !== "active" || session.lifecycle !== "ready") continue
    if (!await ownedByActor(source.agents, id, actor)) continue
    const paths = tree.directories.map(d => d.path)
    const key = directoryKey(paths)
    if (requested.has(id) && key === targetDirectory && (!existing || existing === projectId)) eligible.add(id)
    if (existing) continue
    const group = groups.get(key) ?? { paths, sessionIds: [], projects: projects.filter(p => directoryKey(p.roots) === key).map(({ id, name }) => ({ id, name })) }
    group.sessionIds.push(id)
    groups.set(key, group)
  }
  if (assign && project) {
    if (eligible.size !== requested.size) throw new Error("The history group has changed. Refresh it and choose again.")
    await source.store.update(uid, emptyState, state => {
      const saved = state.historyProjects ??= {}
      const current = ownership(catalog, saved).linked
      for (const id of requested) {
        if (current.has(id) && current.get(id) !== project.id) throw new Error("This session already belongs to another project")
        saved[id] = project.id
      }
    })
    source.historyChanged?.()
  }
  const confirmed = links().linked
  const remaining = [...groups.values()]
    .map(group => ({ ...group, sessionIds: group.sessionIds.filter(id => !confirmed.has(id)) }))
    .filter(group => group.sessionIds.length)
  return { links: Object.fromEntries(confirmed), groups: remaining }
}
