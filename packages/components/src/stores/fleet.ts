import { client as platformClient } from "@deskfleet/client/platform"
import { defineStore } from "pinia"
import { computed, hasInjectionContext, onScopeDispose, ref } from "vue"
import type { CatalogDirectory, CatalogSnapshot, CatalogWorktree, CatalogWorkspace } from "../../../client/src/catalog.ts"
import type { LocalDesktopTarget } from "../../../client/src/desktop-media.ts"
import type { AgentSessionSummary, MachineSummary, TerminalSessionSummary, WorkspaceSummary, WorktreeSummary } from "./fleet-types.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { captureAnalyticsContext } from "../services/analytics.ts"
import { useTerminalsStore } from "./terminals.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { useProvidersStore } from "./providers.ts"

export interface WorkspaceLocation {
  machine: MachineSummary
  workspace: WorkspaceSummary
}
/** A new or existing Session target; workspace is absent for machine-scoped chat. */
export interface SessionTarget {
  machine: MachineSummary
  workspace?: WorkspaceSummary
  session?: AgentSessionSummary
  worktree?: WorktreeSummary
}
export interface SessionLocation extends SessionTarget {
  session: AgentSessionSummary
}
/** Every worktree exposed by the client belongs to a Session. */
export interface WorktreeLocation extends SessionLocation {
  worktree: WorktreeSummary
}
/** Ownership is explicit; a terminal's working directory never determines its scope. */
export interface TerminalLocation {
  machine: MachineSummary
  workspace?: WorkspaceSummary
  session?: AgentSessionSummary
  worktree?: WorktreeSummary
  terminal: TerminalSessionSummary
}

function* worktreeLocations(machines: MachineSummary[]): Generator<WorktreeLocation> {
  for (const machine of machines) {
    for (const session of machine.sessions) if (session.worktree) yield { machine, session, worktree: session.worktree }
    for (const workspace of machine.workspaces) {
      for (const session of workspace.sessions) if (session.worktree) yield { machine, workspace, session, worktree: session.worktree }
    }
  }
}
function* terminalLocations(machines: MachineSummary[]): Generator<TerminalLocation> {
  for (const machine of machines) {
    for (const terminal of machine.terminals) yield { machine, terminal }
    for (const session of machine.sessions) {
      for (const terminal of session.worktree?.terminals ?? []) yield { machine, session, worktree: session.worktree, terminal }
    }
    for (const workspace of machine.workspaces) {
      for (const terminal of workspace.terminals) yield { machine, workspace, terminal }
      for (const session of workspace.sessions) {
        for (const terminal of session.worktree?.terminals ?? []) yield { machine, workspace, session, worktree: session.worktree, terminal }
      }
    }
  }
}
function worktreeSummary(value: CatalogWorktree): WorktreeSummary {
  return { id: value.id, directories: value.directories.map(directory => ({ ...directory, git: undefined })), terminals: [] }
}
function workspaceSummary(value: CatalogWorkspace): WorkspaceSummary {
  const main = value.worktrees.find(worktree => worktree.sessionId === undefined)
  return {
    id: value.id,
    name: value.name,
    directories: main?.directories.map(directory => ({ ...directory, git: undefined })) ?? [],
    sessions: value.worktrees.flatMap(worktree => worktree.sessionId === undefined ? [] : [{ id: worktree.sessionId, worktree: worktreeSummary(worktree) }]),
    terminals: [],
  }
}

/** Selected machine resources; database IDs and connection targets have separate identities. */
export const useFleetStore = defineStore("fleet", () => {
  const account = hasInjectionContext() ? useAccountSession() : undefined
  const target = platformClient.target
  const targetId = target?.id ?? "local-daemon"
  const localDesktopTarget = ref<LocalDesktopTarget>({ id: targetId, name: "localhost", online: false, desktop: false })
  const catalog = ref<CatalogSnapshot | null>(null)
  const catalogIdentity = computed(() => catalog.value && { teamId: catalog.value.teamId, machineId: catalog.value.machineId })
  const catalogError = ref<string | null>(null)
  const catalogLoading = ref(false)
  const catalogReady = ref(false)
  const targetWorkspaceId = ref<string | null>(null)
  const collapsedMachineIds = ref(new Set<string>())
  const terminals = useTerminalsStore()
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  // Build the resource tree from its owning stores instead of synchronizing copies.
  const workspaces = computed(() => (catalog.value?.workspaces ?? []).map(value => {
    const workspace = workspaceSummary(value)
    const summaries = new Map(workspace.sessions.map(session => [session.id, session]))
    for (const metadata of Object.values(agents.sessions)) {
      if (metadata.workspaceId !== workspace.id) continue
      const provider = providers.providers.find(provider => provider.id === metadata.provider)
      summaries.set(metadata.id, {
        ...summaries.get(metadata.id), id: metadata.id,
        title: metadata.title, provider: provider?.name, providerIcon: provider?.icon,
        providerTemplate: provider?.template, providerUnavailable: providers.loaded && !provider,
        context: metadata.context, archiveState: metadata.archiveState,
      })
    }
    workspace.sessions = [...summaries.values()]
    for (const session of workspace.sessions) {
      if (session.worktree) session.worktree.terminals = terminals.sessions.filter(terminal => terminal.worktreeId === session.worktree!.id)
    }
    return workspace
  }))
  const machineSessions = computed(() => {
    const summaries = new Map<string, AgentSessionSummary>()
    for (const worktree of catalog.value?.sessions ?? []) {
      if (!worktree.sessionId) continue
      summaries.set(worktree.sessionId, { id: worktree.sessionId, worktree: worktreeSummary(worktree) })
    }
    for (const metadata of Object.values(agents.sessions)) {
      if (metadata.workspaceId) continue
      const provider = providers.providers.find(provider => provider.id === metadata.provider)
      summaries.set(metadata.id, {
        ...summaries.get(metadata.id), id: metadata.id,
        title: metadata.title, provider: provider?.name, providerIcon: provider?.icon,
        providerTemplate: provider?.template, providerUnavailable: providers.loaded && !provider,
        context: metadata.context, archiveState: metadata.archiveState,
      })
    }
    const values = [...summaries.values()]
    for (const session of values) {
      if (session.worktree) session.worktree.terminals = terminals.sessions.filter(terminal => terminal.worktreeId === session.worktree!.id)
    }
    return values
  })
  const machines = computed<MachineSummary[]>(() => [{
    id: targetId, name: localDesktopTarget.value.name, online: localDesktopTarget.value.online,
    desktop: localDesktopTarget.value.desktop,
    // The server transport also connects this client's own daemon.
    local: account ? account.localMachineId.value === targetId : target?.local ?? true,
    lastSeen: target?.lastSeen,
    terminals: terminals.sessions.filter(terminal => terminal.worktreeId === undefined),
    sessions: machineSessions.value,
    workspaces: workspaces.value,
  }])
  let refreshingTarget: Promise<LocalDesktopTarget> | null = null
  let refreshingCatalog: Promise<void> | null = null
  let refreshRequested = false

  function findWorkspace(workspaceId: string): WorkspaceLocation | null {
    for (const machine of machines.value) {
      const workspace = machine.workspaces.find(({ id }) => id === workspaceId)
      if (workspace) return { machine, workspace }
    }
    return null
  }
  function findWorktree(worktreeId: string | null): WorktreeLocation | null {
    return [...worktreeLocations(machines.value)].find(({ worktree }) => worktree.id === worktreeId) ?? null
  }
  function reconcileTarget(): void {
    const values = catalog.value?.workspaces ?? []
    if (!values.some(workspace => workspace.id === targetWorkspaceId.value)) targetWorkspaceId.value = values[0]?.id ?? null
  }
  function applySnapshot(snapshot: CatalogSnapshot): void {
    catalog.value = snapshot
    localDesktopTarget.value = { ...localDesktopTarget.value, name: snapshot.machineName, online: target ? localDesktopTarget.value.online : true, error: undefined }
    catalogReady.value = true
    catalogError.value = null
    reconcileTarget()
  }
  function refreshLocalDesktop(): Promise<LocalDesktopTarget> {
    refreshingTarget ??= platformClient.desktop.target().catch((error: unknown) => ({
      ...localDesktopTarget.value, online: false, error: error instanceof Error ? error.message : String(error),
    })).then(target => {
      localDesktopTarget.value = target
      if (!target.online) catalogReady.value = false
      return target
    }).finally(() => { refreshingTarget = null })
    return refreshingTarget
  }
  function refreshLocalCatalog(): Promise<void> {
    refreshRequested = true
    refreshingCatalog ??= (async () => {
      // Background catalog/presence updates keep the current workspace visible.
      catalogLoading.value = catalogIdentity.value === null
      try {
        do {
          refreshRequested = false
          const snapshot = await platformClient.catalog.list()
          if (!refreshRequested) applySnapshot(snapshot)
        } while (refreshRequested)
      } catch (error) {
        catalogError.value = error instanceof Error ? error.message : String(error)
        catalogReady.value = false
        localDesktopTarget.value = { ...localDesktopTarget.value, online: false }
      } finally {
        catalogLoading.value = false
        refreshingCatalog = null
      }
    })()
    return refreshingCatalog
  }
  async function refreshLocal(): Promise<void> {
    await refreshLocalDesktop()
    await refreshLocalCatalog()
  }
  const unsubscribe = platformClient.catalog.onChanged(sessionId => {
    // A remote machine's presence and renames arrive as catalog changes. Its catalog,
    // applied after the target, carries the current Team name.
    if (!sessionId) {
      void (target ? refreshLocal() : refreshLocalCatalog())
      void terminals.refresh()
    }
    void agents.refresh(sessionId)
  })
  onScopeDispose(unsubscribe)
  const canManageCatalog = computed(() => localDesktopTarget.value.online && catalogReady.value)
  function requireLocalCatalog(): void {
    if (!canManageCatalog.value) throw new Error(catalogError.value ?? "The local daemon is unavailable")
  }
  function requireWorkspace(id: string): WorkspaceLocation {
    requireLocalCatalog()
    const location = findWorkspace(id)
    if (!location || location.machine.id !== targetId) throw new Error("Workspace is not on the local daemon")
    return location
  }
  async function createWorkspace(name: string, directories: CatalogDirectory[]): Promise<CatalogWorkspace> {
    requireLocalCatalog()
    const track = captureAnalyticsContext()
    const value = await platformClient.catalog.createWorkspace(name, directories)
    const workspaces = catalog.value!.workspaces
    const index = workspaces.findIndex(workspace => workspace.id === value.id)
    if (index === -1) workspaces.push(value)
    else workspaces[index] = value
    targetWorkspaceId.value = value.id
    track("workspace_created", { directory_count: directories.length })
    return value
  }
  async function updateWorkspace(id: string, name: string, directories: CatalogDirectory[]): Promise<void> {
    requireWorkspace(id)
    const value = await platformClient.catalog.updateWorkspace(id, name, directories)
    const index = catalog.value!.workspaces.findIndex(workspace => workspace.id === id)
    if (index !== -1) catalog.value!.workspaces[index] = value
    reconcileTarget()
  }
  async function deleteWorkspace(id: string): Promise<void> {
    requireWorkspace(id)
    await platformClient.catalog.deleteWorkspace(id)
    catalog.value!.workspaces = catalog.value!.workspaces.filter(workspace => workspace.id !== id)
    reconcileTarget()
  }
  function findSession(sessionId: string): SessionLocation | null {
    for (const machine of machines.value) {
      const orphan = machine.sessions.find(session => session.id === sessionId)
      if (orphan) return { machine, session: orphan, worktree: orphan.worktree }
      for (const workspace of machine.workspaces) {
        const session = workspace.sessions.find(session => session.id === sessionId)
        if (session) return { machine, workspace, session, worktree: session.worktree }
      }
    }
    return null
  }
  function findTerminal(id: string): TerminalLocation | null {
    return [...terminalLocations(machines.value)].find(({ terminal }) => terminal.id === id) ?? null
  }
  function findMachine(id: string): MachineSummary | null { return machines.value.find(machine => machine.id === id) ?? null }
  function isCollapsed(id: string): boolean { return collapsedMachineIds.value.has(id) }
  function toggleMachine(id: string): void { if (!collapsedMachineIds.value.delete(id)) collapsedMachineIds.value.add(id) }
  function targetWorkspace(id: string): void { targetWorkspaceId.value = id }
  const newSessionTarget = computed<SessionTarget | null>(() => {
    if (targetWorkspaceId.value) return findWorkspace(targetWorkspaceId.value)
    const machine = findMachine(targetId)
    return machine ? { machine } : null
  })

  return {
    targetId, machines, catalog, catalogIdentity, catalogError, catalogLoading, catalogReady, canManageCatalog,
    localDesktopTarget, refreshLocalDesktop, refreshLocalCatalog, refreshLocal,
    createWorkspace, updateWorkspace, deleteWorkspace,
    newSessionTarget, findMachine, findWorkspace, findWorktree, findSession, findTerminal,
    collapsedMachineIds, isCollapsed, toggleMachine, targetWorkspaceId, targetWorkspace,
  }
})
