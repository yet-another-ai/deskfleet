import type { AgentSessionSummary as CentralAgentSessionSummary } from "@deskfleet/client/central"
import type { SaVisibleMarkerRef, SuperWorkspaceActivity, SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import type { AgentSessionSummary } from "../stores/fleet-types.ts"
import { sessionIsUnread, type SessionActivity } from "./agent-conversation.ts"
import type { SidebarSessionFilter } from "../composables/useSidebarFilter.ts"

export type SessionIndicatorState = SessionActivity | "archiving"

const INDICATOR_RANK: Record<SessionIndicatorState, number> = {
  archiving: 4,
  permission: 3,
  question: 2,
  working: 1,
}

export function mergeSidebarIndicator(
  left: SessionIndicatorState | SuperWorkspaceActivity | false | undefined,
  right: SessionIndicatorState | SuperWorkspaceActivity | false | undefined,
): SessionIndicatorState | false {
  const a = left || false
  const b = right || false
  if (!a) return b
  if (!b) return a
  return INDICATOR_RANK[b] > INDICATOR_RANK[a] ? b : a
}

export interface WorkspaceSaViewState {
  workspaceId: SuperWorkspaceId
  latestVisible?: SaVisibleMarkerRef
  lastRead?: SaVisibleMarkerRef
  unread: boolean
  working: SuperWorkspaceActivity
  saActive: boolean
  activeDelegatedSessionIds: string[]
  delegatedCompletedSeqs: Record<string, string>
}

export interface UnopenedSessionSummary {
  id: string
  workspaceId?: string
  archiveState: string
  lastCompletedSeq?: string
  lastReadSeq?: string
  working: SessionIndicatorState | false
}

export interface MachineSaSummaryRecord {
  status: "unknown" | "ready" | "error"
  workspaces: Record<string, WorkspaceSaViewState>
  privateWorkspaceId?: string
  unopenedSessions?: UnopenedSessionSummary[]
  loadedAt?: number
}

export function workspaceSummaryKey(workspaceId: SuperWorkspaceId): string {
  return workspaceId ?? ""
}

export function isDelegatedWorkerResultRepresented(
  session: Pick<AgentSessionSummary, "id" | "lastCompletedSeq">,
  delegatedCompletedSeqs: Readonly<Record<string, string>> | undefined,
): boolean {
  const delivered = delegatedCompletedSeqs?.[session.id]
  const completed = session.lastCompletedSeq
  if (!delivered || !completed) return false
  try {
    return BigInt(delivered) >= BigInt(completed)
  } catch {
    return false
  }
}

export function summarizeUnopenedCentralSession(item: CentralAgentSessionSummary): UnopenedSessionSummary {
  const session = item.session
  let working: SessionIndicatorState | false = false
  if (session.archiveState === "archiving") {
    working = "archiving"
  } else if (item.permissions.some(permission => permission.state === "pending")) {
    working = "permission"
  } else if (item.elicitations.some(elicitation => elicitation.state === "pending")) {
    working = "question"
  } else if (item.turns.some(turn => turn.state === "starting" || turn.state === "running" || turn.state === "cancelling")) {
    working = "working"
  }
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    archiveState: session.archiveState,
    lastCompletedSeq: session.lastCompletedSeq,
    lastReadSeq: session.lastReadSeq,
    working,
  }
}

export interface WorkspaceSidebarRowSummary {
  workspaceId: SuperWorkspaceId
  /** Working/attention indicator merged across SA and child Workers (paused when offline). */
  working: SessionIndicatorState | false
  /** SA-only working/attention indicator (paused when offline). */
  saWorking: SessionIndicatorState | false
  /** True iff the SA conversation itself has unread visible content. */
  saUnread: boolean
  unreadCount: number
  workingCount: number
  matchedWorkers: AgentSessionSummary[]
  matchedSa: boolean
  /** True when the active filter matched child Worker rows and this row should auto-expand. */
  autoExpand: boolean
  /** True when this workspace row should be shown under the active filter. */
  visible: boolean
}

export interface MachineSidebarSummaryResult {
  unknown: boolean
  counts: { unread: number; working: number; unknown?: boolean }
  machineWorking: SessionIndicatorState | false
  machineUnread: boolean
  defaultWorkspace: WorkspaceSidebarRowSummary
  workspaces: Map<string, WorkspaceSidebarRowSummary>
  unassigned: {
    matched: AgentSessionSummary[]
    unreadCount: number
    workingCount: number
    working: SessionIndicatorState | false
    autoExpand: boolean
  }
  workerUnreadById: Map<string, boolean>
  workerWorkingById: Map<string, SessionIndicatorState | false>
}

export interface ComputeMachineSidebarSummaryInput {
  online: boolean
  unopened: boolean
  filter: SidebarSessionFilter
  hiddenWorkspaceIds: ReadonlySet<string>
  defaultSessions: readonly AgentSessionSummary[]
  workspaces: readonly { id: string; allSessions: readonly AgentSessionSummary[] }[]
  unassignedSessions: readonly AgentSessionSummary[]
  sessionIndicator: (session: { id: string; archiveState?: string }) => SessionIndicatorState | false
  saSummary?: MachineSaSummaryRecord
}

function summarizeWorkspaceGroup(params: {
  workspaceId: SuperWorkspaceId
  sessions: readonly AgentSessionSummary[]
  wsSa: WorkspaceSaViewState | undefined
  online: boolean
  filter: SidebarSessionFilter
  sessionIndicator: (session: { id: string; archiveState?: string }) => SessionIndicatorState | false
  workerUnreadById: Map<string, boolean>
  workerWorkingById: Map<string, SessionIndicatorState | false>
}): WorkspaceSidebarRowSummary {
  const { workspaceId, sessions, wsSa, online, filter, sessionIndicator, workerUnreadById, workerWorkingById } = params
  const saUnread = wsSa?.unread === true
  const saWorking: SessionIndicatorState | false = online ? (wsSa?.working || false) : false
  const delegatedSet = new Set(wsSa?.activeDelegatedSessionIds ?? [])

  let childWorkingIndicator: SessionIndicatorState | false = false
  let workingWorkerCount = 0
  let unreadWorkerCount = 0
  let hasWorkingDelegatedChild = false
  const matchedWorkers: AgentSessionSummary[] = []

  for (const session of sessions) {
    const rawIndicator = online ? sessionIndicator(session) : false
    workerWorkingById.set(session.id, rawIndicator)
    const represented = isDelegatedWorkerResultRepresented(session, wsSa?.delegatedCompletedSeqs)
    const isUnread = !rawIndicator && sessionIsUnread(session) && !represented
    workerUnreadById.set(session.id, isUnread)

    if (rawIndicator) {
      workingWorkerCount++
      childWorkingIndicator = mergeSidebarIndicator(childWorkingIndicator, rawIndicator)
      if (delegatedSet.has(session.id)) hasWorkingDelegatedChild = true
    } else if (isUnread) {
      unreadWorkerCount++
    }

    if (filter === "all" || (filter === "working" ? Boolean(rawIndicator) : isUnread)) {
      matchedWorkers.push(session)
    }
  }

  // Count SA working once if SA itself is executing (routing / direct answer / unbound pending request)
  // without double-counting an already-counted delegated Worker session.
  const saContributesWorking = Boolean(saWorking) && (!hasWorkingDelegatedChild || (wsSa?.saActive === true && delegatedSet.size === 0))
  const workingCount = online ? workingWorkerCount + (saContributesWorking ? 1 : 0) : 0
  const unreadCount = (saUnread ? 1 : 0) + unreadWorkerCount
  const working = online ? mergeSidebarIndicator(saWorking, childWorkingIndicator) : false

  const matchedSa = filter === "unread"
    ? saUnread
    : filter === "working"
      ? Boolean(saWorking) && saContributesWorking
      : true
  const autoExpand = filter !== "all" && matchedWorkers.length > 0
  const visible = filter === "all" || matchedSa || matchedWorkers.length > 0

  return {
    workspaceId,
    working,
    saWorking,
    saUnread,
    unreadCount,
    workingCount,
    matchedWorkers,
    matchedSa,
    autoExpand,
    visible,
  }
}

/**
 * Unified SA-mode sidebar summary shared by project rows, default workspace,
 * unassigned sessions, collapsed machine header, and top filter counts.
 */
export function computeMachineSidebarSummary(input: ComputeMachineSidebarSummaryInput): MachineSidebarSummaryResult {
  const workerUnreadById = new Map<string, boolean>()
  const workerWorkingById = new Map<string, SessionIndicatorState | false>()
  const workspacesMap = new Map<string, WorkspaceSidebarRowSummary>()
  const saWorkspaces = input.saSummary?.workspaces ?? {}

  if (input.unopened) {
    const ready = input.saSummary?.status === "ready"
    const allWsEntries = Object.values(saWorkspaces).filter(ws =>
      ws.workspaceId === null || !input.hiddenWorkspaceIds.has(ws.workspaceId),
    )
    const delegatedByWorkspace = new Map<string, Record<string, string>>()
    const activeDelegatedAll = new Set<string>()
    let totalUnread = 0
    let totalWorking = 0
    let machineWorking: SessionIndicatorState | false = false

    for (const ws of allWsEntries) {
      delegatedByWorkspace.set(workspaceSummaryKey(ws.workspaceId), ws.delegatedCompletedSeqs)
      for (const sid of ws.activeDelegatedSessionIds) activeDelegatedAll.add(sid)
      if (ws.unread) totalUnread++
      if (input.online && ws.working) {
        machineWorking = mergeSidebarIndicator(machineWorking, ws.working)
      }
    }

    const activeSessions = (input.saSummary?.unopenedSessions ?? []).filter(s => s.archiveState === "active" || s.archiveState === "archiving")
    const workingDelegatedSessions = new Set<string>()
    for (const session of activeSessions) {
      const wsId = session.workspaceId === input.saSummary?.privateWorkspaceId ? null : (session.workspaceId ?? undefined)
      if (wsId && input.hiddenWorkspaceIds.has(wsId)) continue
      const indicator: SessionIndicatorState | false = input.online ? session.working : false
      workerWorkingById.set(session.id, indicator)
      const wsDelegated = wsId !== undefined ? delegatedByWorkspace.get(workspaceSummaryKey(wsId)) : undefined
      const represented = isDelegatedWorkerResultRepresented(session, wsDelegated)
      const isUnread = !indicator && sessionIsUnread(session) && !represented
      workerUnreadById.set(session.id, isUnread)
      if (indicator) {
        totalWorking++
        machineWorking = mergeSidebarIndicator(machineWorking, indicator)
        if (activeDelegatedAll.has(session.id)) workingDelegatedSessions.add(session.id)
      } else if (isUnread) {
        totalUnread++
      }
    }

    if (input.online) {
      for (const ws of allWsEntries) {
        if (!ws.working) continue
        const coveredByChild = ws.activeDelegatedSessionIds.some(sid => workingDelegatedSessions.has(sid))
        if (!coveredByChild || (ws.saActive && ws.activeDelegatedSessionIds.length === 0)) {
          totalWorking++
        }
      }
    }

    const unknown = !ready
    const emptyDefault: WorkspaceSidebarRowSummary = {
      workspaceId: null,
      working: input.online ? (saWorkspaces[""]?.working || false) : false,
      saWorking: input.online ? (saWorkspaces[""]?.working || false) : false,
      saUnread: saWorkspaces[""]?.unread === true,
      unreadCount: saWorkspaces[""]?.unread ? 1 : 0,
      workingCount: input.online && saWorkspaces[""]?.working ? 1 : 0,
      matchedWorkers: [],
      matchedSa: false,
      autoExpand: false,
      visible: input.filter === "all",
    }

    return {
      unknown,
      counts: { unread: totalUnread, working: input.online ? totalWorking : 0, ...(unknown ? { unknown: true } : {}) },
      machineWorking: input.online ? machineWorking : false,
      machineUnread: totalUnread > 0,
      defaultWorkspace: emptyDefault,
      workspaces: workspacesMap,
      unassigned: { matched: [], unreadCount: 0, workingCount: 0, working: false, autoExpand: false },
      workerUnreadById,
      workerWorkingById,
    }
  }

  const defaultWorkspace = summarizeWorkspaceGroup({
    workspaceId: null,
    sessions: input.defaultSessions,
    wsSa: saWorkspaces[""],
    online: input.online,
    filter: input.filter,
    sessionIndicator: input.sessionIndicator,
    workerUnreadById,
    workerWorkingById,
  })

  let totalUnread = defaultWorkspace.unreadCount
  let totalWorking = defaultWorkspace.workingCount
  let machineWorking: SessionIndicatorState | false = defaultWorkspace.working

  for (const workspace of input.workspaces) {
    const summary = summarizeWorkspaceGroup({
      workspaceId: workspace.id,
      sessions: workspace.allSessions,
      wsSa: saWorkspaces[workspace.id],
      online: input.online,
      filter: input.filter,
      sessionIndicator: input.sessionIndicator,
      workerUnreadById,
      workerWorkingById,
    })
    workspacesMap.set(workspace.id, summary)
    totalUnread += summary.unreadCount
    totalWorking += summary.workingCount
    machineWorking = mergeSidebarIndicator(machineWorking, summary.working)
  }

  let unassignedUnread = 0
  let unassignedWorkingCount = 0
  let unassignedWorking: SessionIndicatorState | false = false
  const matchedUnassigned: AgentSessionSummary[] = []
  for (const session of input.unassignedSessions) {
    const rawIndicator = input.online ? input.sessionIndicator(session) : false
    workerWorkingById.set(session.id, rawIndicator)
    const isUnread = !rawIndicator && sessionIsUnread(session)
    workerUnreadById.set(session.id, isUnread)
    if (rawIndicator) {
      unassignedWorkingCount++
      unassignedWorking = mergeSidebarIndicator(unassignedWorking, rawIndicator)
    } else if (isUnread) {
      unassignedUnread++
    }
    if (input.filter === "all" || (input.filter === "working" ? Boolean(rawIndicator) : isUnread)) {
      matchedUnassigned.push(session)
    }
  }
  totalUnread += unassignedUnread
  totalWorking += unassignedWorkingCount
  machineWorking = mergeSidebarIndicator(machineWorking, unassignedWorking)

  return {
    unknown: false,
    counts: { unread: totalUnread, working: input.online ? totalWorking : 0 },
    machineWorking: input.online ? machineWorking : false,
    machineUnread: totalUnread > 0,
    defaultWorkspace,
    workspaces: workspacesMap,
    unassigned: {
      matched: matchedUnassigned,
      unreadCount: unassignedUnread,
      workingCount: input.online ? unassignedWorkingCount : 0,
      working: input.online ? unassignedWorking : false,
      autoExpand: input.filter !== "all" && matchedUnassigned.length > 0,
    },
    workerUnreadById,
    workerWorkingById,
  }
}
