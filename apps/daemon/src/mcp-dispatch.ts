import type { AgentActor } from "./agent-protocol.ts"
import type { MachineOperations } from "./machine-operations.ts"
import type { ScheduledTask } from "./schedule-protocol.ts"

export interface McpScope { sessionId: string; workspaceId?: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected tool arguments")
  return value as Record<string, unknown>
}

/** Workspace Sessions share their Workspace; machine-scoped Sessions are isolated to themselves. */
function sameDelegation(session: { id: string; workspaceId?: string }, scope: McpScope): boolean {
  if (scope.workspaceId !== undefined) return session.workspaceId === scope.workspaceId
  return session.id === scope.sessionId && session.workspaceId === undefined
}

/** A generated argument can select resources only inside the issuing Session's delegation. */
export async function dispatchMcp(
  operations: MachineOperations, method: string, value: unknown, actor: AgentActor, scope: McpScope,
): Promise<unknown> {
  const params = object(value)
  const source = await operations.agents.requireActive(scope.sessionId)
  if (source.session.workspaceId !== scope.workspaceId) throw new Error("MCP delegation scope no longer exists")
  if (method === "catalogList") {
    const catalog = await operations.catalog.native.snapshot()
    return {
      ...catalog,
      sessionId: scope.sessionId,
      ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
      workspaces: catalog.workspaces.filter(workspace => workspace.id === scope.workspaceId),
      // Machine-scoped worktrees live here; never leak other Sessions' checkouts.
      sessions: catalog.sessions.filter(worktree => worktree.sessionId === scope.sessionId),
    }
  }
  if (method === "_deskfleet/session/list") {
    return (await operations.agents.journal.list()).filter(session => sameDelegation(session, scope))
  }
  if (method === "_deskfleet/session/subscribe" || method === "_deskfleet/session/history") {
    if (typeof params.sessionId !== "string") throw new Error("A Session ID is required")
    const snapshot = await operations.agents.journal.read(params.sessionId)
    if (!sameDelegation(snapshot.session, scope)) throw new Error("Session is outside this MCP delegation")
    return operations.agents.handle(method, params, actor)
  }
  if (method === "providerList") return operations.providers.metadata()
  if (method === "scheduleList") {
    const tasks = await operations.handle(method, {}, actor) as ScheduledTask[]
    return tasks.filter(task => task.workspaceId === scope.workspaceId)
  }
  if (method === "scheduleCreate") {
    if (scope.workspaceId === undefined) throw new Error("Schedules require a Workspace")
    const schedule = object(params.schedule)
    if (schedule.workspaceId !== undefined && schedule.workspaceId !== scope.workspaceId) throw new Error("Schedule is outside this MCP delegation")
    return operations.handle(method, { schedule: { ...schedule, workspaceId: scope.workspaceId } }, actor)
  }
  if (["scheduleUpdate", "scheduleDelete", "scheduleRun"].includes(method)) {
    if (scope.workspaceId === undefined) throw new Error("Schedules require a Workspace")
    const tasks = await operations.handle("scheduleList", {}, actor) as ScheduledTask[]
    const task = tasks.find(task => task.id === params.scheduleId)
    if (!task || task.workspaceId !== scope.workspaceId) throw new Error("Schedule is outside this MCP delegation")
    if (method === "scheduleUpdate") {
      const changes = object(params.changes)
      if (changes.workspaceId !== undefined && changes.workspaceId !== scope.workspaceId) throw new Error("Schedule is outside this MCP delegation")
    }
    return operations.handle(method, params, actor)
  }
  throw new Error("This operation is unavailable through session MCP tools")
}
