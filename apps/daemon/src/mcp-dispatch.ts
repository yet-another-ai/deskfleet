import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AgentActor, AgentSnapshot } from "./agent-protocol.ts"
import { validateCatalogParams } from "./catalog-protocol.ts"
import type { MachineOperations } from "./machine-operations.ts"
import { dispatchRemoteFiles, dispatchRemoteFileTransfer } from "./mcp-files.ts"
import type { ScheduledTask } from "./schedule-protocol.ts"
import type { RemoteMcpOperation, RemoteMcpRequest } from "../../../crates/protocol/control.ts"

export interface McpScope { sessionId: string; workspaceId?: string; superAgent?: boolean }

const nonEmpty = z.string().refine(v => v.trim().length > 0)
const sessionCreateSchema = z.strictObject({
  workspaceId: nonEmpty.optional(), provider: nonEmpty, context: z.enum(["worktree", "directory"]).default("directory"),
  title: nonEmpty.optional(), prompt: nonEmpty.optional(), baseBranch: nonEmpty.optional(),
  yolo: z.boolean().optional(),
  configuration: z.strictObject({ model: nonEmpty.optional(), reasoningEffort: nonEmpty.optional(), mode: nonEmpty.optional() }).optional(),
})
const sessionSendSchema = z.strictObject({
  sessionId: nonEmpty, prompt: nonEmpty, delivery: z.enum(["backlog", "steer"]).default("backlog"), turnId: nonEmpty.optional(),
})
const workspaceCreateSchema = z.strictObject({
  name: nonEmpty,
  directories: z.array(z.strictObject({ path: nonEmpty })).min(1),
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

function validateWorkspaceCreate(params: Record<string, unknown>) {
  const parsed = workspaceCreateSchema.parse(params)
  validateCatalogParams("workspaceCreate", parsed)
  return parsed
}

export async function createMcpWorkspace(catalog: MachineOperations["catalog"], params: Record<string, unknown>): Promise<unknown> {
  const validated = validateWorkspaceCreate(params)
  return catalog.handle({ method: "workspaceCreate", params: validated })
}

function resolveChildYolo(requested: boolean | undefined, parentYolo: boolean | undefined): boolean | undefined {
  if (parentYolo) return requested === false ? undefined : true
  if (requested === true) throw new Error("Only a YOLO Session can create a YOLO child Session")
  return undefined
}

export async function createMcpSession(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
  const { workspaceId, provider, context, title, prompt, baseBranch, yolo, configuration } = validateSessionCreate(params)
  const snapshot = await agents.handle("_deskfleet/session/create", {
    ...(workspaceId ? { workspaceId } : {}), operationId: randomUUID(), ...(title ? { title } : {}),
    provider, context, ...(baseBranch ? { baseBranch } : {}), ...(yolo ? { yolo: true } : {}), ...configuration,
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

/** Workspace Sessions share their Workspace unless cross-workspace delegation is enabled; machine-scoped and Super Agent Sessions can delegate into any Workspace without seeing other machine-scoped Sessions. */
function sameDelegation(session: { id: string; workspaceId?: string }, scope: McpScope, crossWorkspace: boolean): boolean {
  if (!crossWorkspace) return session.workspaceId === scope.workspaceId
  return session.id === scope.sessionId || session.workspaceId !== undefined
}

/** Local resources stay within the Session's delegation; remote tools use a separately authorized route. */
export async function dispatchMcp(
  operations: MachineOperations, method: string, value: unknown, actor: AgentActor, scope: McpScope,
  remote?: (request: RemoteMcpRequest) => Promise<unknown>,
  allowLocalCrossWorkspace?: () => Promise<boolean> | boolean,
): Promise<unknown> {
  const params = object(value)
  const source = await operations.agents.requireActive(scope.sessionId)
  if (source.session.workspaceId !== scope.workspaceId || Boolean(source.session.superAgent) !== Boolean(scope.superAgent)) {
    throw new Error("MCP delegation scope no longer exists")
  }
  const machineOrSuperScope = scope.workspaceId === undefined || scope.superAgent === true
  const crossWorkspace = machineOrSuperScope || Boolean(await allowLocalCrossWorkspace?.())
  if (method.startsWith("remoteMcp/")) {
    const operation = method.slice("remoteMcp/".length)
    if (!["machines", "machine", "sessions", "session", "history", "sessionCreate", "sessionSend", "workspaceCreate", "mcpServers", "mcpTools", "mcpCall", "files", "fileUpload", "fileDownload"].includes(operation)) throw new Error("Unsupported remote MCP operation")
    if (!remote || actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("Remote Agent delegation is unavailable")
    const { machineId, ...args } = params
    if (operation !== "machines" && (typeof machineId !== "string" || !machineId)) throw new Error("A target machine is required")
    if (operation === "machines" && machineId !== undefined) throw new Error("Machine discovery takes no target")
    let remoteArgs = args
    if (operation === "sessionCreate") {
      const parsed = validateSessionCreate(args)
      const effectiveYolo = resolveChildYolo(parsed.yolo, source.session.yolo)
      const { yolo: _requestedYolo, ...rest } = args
      remoteArgs = effectiveYolo ? { ...rest, yolo: true } : rest
    }
    if (operation === "sessionSend") validateSessionSend(args)
    if (operation === "workspaceCreate") validateWorkspaceCreate(args)
    const { userId, deviceId } = actor
    const callRemote = (remoteOperation: RemoteMcpOperation, callArgs: Record<string, unknown>) =>
      remote({ userId, deviceId, sessionId: scope.sessionId, operation: remoteOperation, ...(typeof machineId === "string" ? { machineId } : {}), arguments: callArgs })
    if (operation === "files") return dispatchRemoteFiles(args, callRemote)
    if (operation === "fileUpload" || operation === "fileDownload") {
      return dispatchRemoteFileTransfer(operation === "fileUpload" ? "upload" : "download", machineId as string, args, callRemote)
    }
    return callRemote(operation as RemoteMcpOperation, remoteArgs)
  }
  if (method === "catalogList") {
    const catalog = await operations.catalog.native.snapshot()
    return {
      ...catalog,
      sessionId: scope.sessionId,
      ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
      workspaces: crossWorkspace
        ? catalog.workspaces
        : catalog.workspaces.filter(workspace => workspace.id === scope.workspaceId),
      // Machine-scoped worktrees live here; never leak other Sessions' checkouts.
      sessions: catalog.sessions.filter(worktree => worktree.sessionId === scope.sessionId),
    }
  }
  if (method === "workspaceCreate") {
    if (!machineOrSuperScope) throw new Error("Workspace is outside this MCP delegation")
    return createMcpWorkspace(operations.catalog, params)
  }
  if (method === "_deskfleet/session/list") {
    return (await operations.agents.journal.list()).filter(session => sameDelegation(session, scope, crossWorkspace))
  }
  if (method === "_deskfleet/session/subscribe" || method === "_deskfleet/session/history" || method === "_deskfleet/input/submit") {
    if (typeof params.sessionId !== "string") throw new Error("A Session ID is required")
    const snapshot = await operations.agents.journal.read(params.sessionId)
    if (!sameDelegation(snapshot.session, scope, crossWorkspace)) throw new Error("Session is outside this MCP delegation")
    return method === "_deskfleet/input/submit" ? sendMcpSession(operations.agents, params, actor) : operations.agents.handle(method, params, actor)
  }
  if (method === "_deskfleet/session/create") {
    if (!crossWorkspace && params.workspaceId !== undefined && params.workspaceId !== scope.workspaceId) {
      throw new Error("Session is outside this MCP delegation")
    }
    // Workspace Sessions (including opt-in cross-workspace delegation) default to their own Workspace when workspaceId is omitted.
    const candidate = !machineOrSuperScope && params.workspaceId === undefined
      ? { ...params, workspaceId: scope.workspaceId }
      : params
    const parsed = validateSessionCreate(candidate)
    const effectiveYolo = resolveChildYolo(parsed.yolo, source.session.yolo)
    const { yolo: _requestedYolo, ...rest } = candidate
    const normalized = effectiveYolo ? { ...rest, yolo: true } : rest
    if (crossWorkspace && parsed.workspaceId !== undefined) {
      const catalog = await operations.catalog.native.snapshot()
      if (!catalog.workspaces.some(workspace => workspace.id === parsed.workspaceId)) {
        throw new Error(`Unknown Workspace: ${parsed.workspaceId}`)
      }
    }
    return createMcpSession(operations.agents, normalized, actor)
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
