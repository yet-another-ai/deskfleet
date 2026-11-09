import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AgentActor, AgentSnapshot } from "./agent-protocol.ts"
import type { MachineOperations } from "./machine-operations.ts"
import { dispatchRemoteFiles, dispatchRemoteFileTransfer } from "./mcp-files.ts"
import type { ScheduledTask } from "./schedule-protocol.ts"
import type { RemoteMcpOperation, RemoteMcpRequest } from "../../../crates/protocol/control.ts"

export interface McpScope { sessionId: string; workspaceId?: string }

const nonEmpty = z.string().refine(v => v.trim().length > 0)
const sessionCreateSchema = z.strictObject({
  workspaceId: nonEmpty.optional(), provider: nonEmpty, context: z.enum(["worktree", "directory"]).default("directory"),
  title: nonEmpty.optional(), prompt: nonEmpty.optional(), baseBranch: nonEmpty.optional(),
  configuration: z.strictObject({ model: nonEmpty.optional(), reasoningEffort: nonEmpty.optional(), mode: nonEmpty.optional() }).optional(),
})
const sessionSendSchema = z.strictObject({
  sessionId: nonEmpty, prompt: nonEmpty, delivery: z.enum(["backlog", "steer"]).default("backlog"), turnId: nonEmpty.optional(),
})

function validateSessionCreate(params: Record<string, unknown>) {
  const parsed = sessionCreateSchema.parse(params)
  if (!parsed.workspaceId && parsed.context !== "directory") throw new Error("Sessions without a workspace use the home directory")
  if (parsed.baseBranch !== undefined && parsed.context !== "worktree") throw new Error("Invalid base branch")
  return parsed
}

function validateSessionSend(params: Record<string, unknown>) {
  const parsed = sessionSendSchema.parse(params)
  if (parsed.turnId !== undefined && parsed.delivery !== "steer") throw new Error("turnId requires steer delivery")
  return parsed
}

export async function createMcpSession(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
  const { workspaceId, provider, context, title, prompt, baseBranch, configuration } = validateSessionCreate(params)
  const snapshot = await agents.handle("_deskfleet/session/create", {
    ...(workspaceId ? { workspaceId } : {}), operationId: randomUUID(), ...(title ? { title } : {}),
    provider, context, ...(baseBranch ? { baseBranch } : {}), ...configuration,
  }, actor) as AgentSnapshot
  if (snapshot.session?.lifecycle && snapshot.session.lifecycle !== "ready") throw new Error(snapshot.session.error ?? "Session provisioning failed")
  if (prompt === undefined) return snapshot
  await agents.handle("_deskfleet/input/submit", { sessionId: snapshot.session.id, operationId: randomUUID(), content: [{ type: "text", text: prompt }], delivery: "backlog" }, actor)
  return agents.handle("_deskfleet/session/subscribe", { sessionId: snapshot.session.id }, actor)
}

export async function sendMcpSession(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
  const { sessionId, prompt, delivery, turnId } = validateSessionSend(params)
  return agents.handle("_deskfleet/input/submit", { sessionId, operationId: randomUUID(), content: [{ type: "text", text: prompt }], delivery, ...(turnId ? { turnId } : {}) }, actor)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected tool arguments")
  return value as Record<string, unknown>
}

/** Workspace Sessions share their Workspace; machine-scoped Sessions are isolated to themselves. */
function sameDelegation(session: { id: string; workspaceId?: string }, scope: McpScope): boolean {
  if (scope.workspaceId !== undefined) return session.workspaceId === scope.workspaceId
  return session.id === scope.sessionId && session.workspaceId === undefined
}

/** Local resources stay within the Session's delegation; remote tools use a separately authorized route. */
export async function dispatchMcp(
  operations: MachineOperations, method: string, value: unknown, actor: AgentActor, scope: McpScope,
  remote?: (request: RemoteMcpRequest) => Promise<unknown>,
): Promise<unknown> {
  const params = object(value)
  const source = await operations.agents.requireActive(scope.sessionId)
  if (source.session.workspaceId !== scope.workspaceId) throw new Error("MCP delegation scope no longer exists")
  if (method.startsWith("remoteMcp/")) {
    const operation = method.slice("remoteMcp/".length)
    if (!["machines", "machine", "sessions", "session", "history", "sessionCreate", "sessionSend", "mcpServers", "mcpTools", "mcpCall", "files", "fileUpload", "fileDownload"].includes(operation)) throw new Error("Unsupported remote MCP operation")
    if (!remote || actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("Remote Agent delegation is unavailable")
    const { machineId, ...args } = params
    if (operation !== "machines" && (typeof machineId !== "string" || !machineId)) throw new Error("A target machine is required")
    if (operation === "machines" && machineId !== undefined) throw new Error("Machine discovery takes no target")
    if (operation === "sessionCreate") validateSessionCreate(args)
    if (operation === "sessionSend") validateSessionSend(args)
    const { userId, deviceId } = actor
    const callRemote = (remoteOperation: RemoteMcpOperation, remoteArgs: Record<string, unknown>) =>
      remote({ userId, deviceId, sessionId: scope.sessionId, operation: remoteOperation, ...(typeof machineId === "string" ? { machineId } : {}), arguments: remoteArgs })
    if (operation === "files") return dispatchRemoteFiles(args, callRemote)
    if (operation === "fileUpload" || operation === "fileDownload") {
      return dispatchRemoteFileTransfer(operation === "fileUpload" ? "upload" : "download", machineId as string, args, callRemote)
    }
    return callRemote(operation as RemoteMcpOperation, args)
  }
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
  if (method === "_deskfleet/session/subscribe" || method === "_deskfleet/session/history" || method === "_deskfleet/input/submit") {
    if (typeof params.sessionId !== "string") throw new Error("A Session ID is required")
    const snapshot = await operations.agents.journal.read(params.sessionId)
    if (!sameDelegation(snapshot.session, scope)) throw new Error("Session is outside this MCP delegation")
    return method === "_deskfleet/input/submit" ? sendMcpSession(operations.agents, params, actor) : operations.agents.handle(method, params, actor)
  }
  if (method === "_deskfleet/session/create") {
    if (params.workspaceId !== undefined && params.workspaceId !== scope.workspaceId) throw new Error("Session is outside this MCP delegation")
    return createMcpSession(operations.agents, { ...params, ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }) }, actor)
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
