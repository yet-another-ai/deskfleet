import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { validateAgentConfigurationSelection, type AgentConfiguration, type AgentConfigurationSelection } from "@deskfleet/protocol/agent-configuration"
import { validateCatalogParams } from "@deskfleet/protocol/catalog"
import { validateProviderId } from "@deskfleet/protocol/provider"
import type { MachineOperations } from "../machine/operations.ts"
import { dispatchRemoteFiles, dispatchRemoteFileTransfer } from "./files.ts"
import type { ScheduledTask } from "@deskfleet/protocol/schedule"
import type { RemoteMcpOperation, RemoteMcpRequest } from "@deskfleet/protocol/generated/central-control"

export interface McpScope { sessionId: string; workspaceId?: string; superAgent?: boolean }
export interface McpScheduleBridge {
  prepareCreate?(context: { actor: AgentActor; sessionId: string; workspaceId: string; schedule: Record<string, unknown> }): Promise<{
    duplicateOf?: ScheduledTask
    operationId?: string
    scheduleId?: string
    autoSubscribe?: boolean
    deliveryPolicy?: "every_run" | "exceptions_only"
  } | undefined>
  onCreated?(context: { actor: AgentActor; workspaceId: string; task: ScheduledTask; deliveryPolicy?: "every_run" | "exceptions_only" }): Promise<void>
  reportFeedback?(context: { actor: AgentActor; sessionId: string; report: Record<string, unknown> }): Promise<unknown>
}

const nonEmpty = z.string().refine(v => v.trim().length > 0)
const configValuesSchema = z.record(nonEmpty, z.union([nonEmpty, z.boolean()]))
const configurationSchema = z.strictObject({
  model: nonEmpty.optional(),
  reasoningEffort: nonEmpty.optional(),
  mode: nonEmpty.optional(),
  configValues: configValuesSchema.optional(),
})
const providerConfigurationSchema = z.strictObject({
  provider: nonEmpty,
  workspaceId: nonEmpty.optional(),
  configuration: configurationSchema.optional(),
})
const sessionCreateSchema = z.strictObject({
  workspaceId: nonEmpty.optional(), provider: nonEmpty, context: z.enum(["worktree", "directory"]).default("directory"),
  title: nonEmpty.optional(), prompt: nonEmpty.optional(), baseBranch: nonEmpty.optional(),
  yolo: z.boolean().optional(),
  configuration: configurationSchema.optional(),
})
const sessionSendSchema = z.strictObject({
  sessionId: nonEmpty, prompt: nonEmpty, delivery: z.enum(["backlog", "steer"]).default("backlog"), turnId: nonEmpty.optional(),
  provider: nonEmpty.optional(),
  configuration: configurationSchema.optional(),
})
const workspaceCreateSchema = z.strictObject({
  name: nonEmpty,
  directories: z.array(z.strictObject({ path: nonEmpty })).min(1),
})

function hasConfigurationSelection(configuration: AgentConfigurationSelection | undefined): boolean {
  if (!configuration) return false
  return configuration.model !== undefined
    || configuration.reasoningEffort !== undefined
    || configuration.mode !== undefined
    || (configuration.configValues !== undefined && Object.keys(configuration.configValues).length > 0)
}

function validateConfiguration(configuration: AgentConfigurationSelection | undefined): void {
  if (configuration !== undefined) validateAgentConfigurationSelection(configuration as Record<string, unknown>)
}

function validateProviderConfiguration(params: Record<string, unknown>) {
  const parsed = providerConfigurationSchema.parse(params)
  validateProviderId(parsed.provider)
  validateConfiguration(parsed.configuration)
  return parsed
}

function validateSessionCreate(params: Record<string, unknown>) {
  const parsed = sessionCreateSchema.parse(params)
  validateProviderId(parsed.provider)
  validateConfiguration(parsed.configuration)
  if (!parsed.workspaceId && parsed.context !== "directory") throw new Error("Sessions without a workspace use the home directory")
  if (parsed.baseBranch !== undefined && parsed.context !== "worktree") throw new Error("Invalid base branch")
  return parsed
}

function validateSessionSend(params: Record<string, unknown>) {
  const parsed = sessionSendSchema.parse(params)
  if (parsed.provider !== undefined) validateProviderId(parsed.provider)
  validateConfiguration(parsed.configuration)
  if (parsed.turnId !== undefined && parsed.delivery !== "steer") throw new Error("turnId requires steer delivery")
  if (parsed.delivery === "steer" && (parsed.provider !== undefined || hasConfigurationSelection(parsed.configuration))) {
    throw new Error("Changing Agent or configuration requires backlog delivery")
  }
  return parsed
}

function validateWorkspaceCreate(params: Record<string, unknown>) {
  const parsed = workspaceCreateSchema.parse(params)
  validateCatalogParams("workspaceCreate", parsed)
  return parsed
}

function formatMcpProviderConfiguration(configuration: AgentConfiguration | null) {
  if (!configuration) return null
  const primary = new Set([configuration.models?.id, configuration.reasoningEfforts?.id, configuration.modes?.id])
  const extraOptions = (configuration.configOptions ?? []).filter(option => !primary.has(option.id))
  return {
    provider: configuration.provider,
    models: configuration.models,
    reasoningEfforts: configuration.reasoningEfforts,
    modes: configuration.modes,
    ...(extraOptions.length ? { configOptions: extraOptions } : {}),
    ...(configuration.promptCapabilities ? { promptCapabilities: configuration.promptCapabilities } : {}),
  }
}

export async function queryMcpProviderConfiguration(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
  const { provider, workspaceId, configuration } = validateProviderConfiguration(params)
  const result = await agents.handle("_deskfleet/agent/configuration", {
    provider,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...configuration,
    cache: true,
  }, actor) as AgentConfiguration | null
  return formatMcpProviderConfiguration(result)
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

function mcpSender(actor: AgentActor, sourceSuperAgent: boolean | undefined): AgentActor {
  return { ...actor, via: sourceSuperAgent ? "super_agent_mcp" : "mcp" }
}

export async function createMcpSession(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor, sourceSuperAgent: boolean | undefined): Promise<unknown> {
  const { workspaceId, provider, context, title, prompt, baseBranch, yolo, configuration } = validateSessionCreate(params)
  const sender = mcpSender(actor, sourceSuperAgent)
  const snapshot = await agents.handle("_deskfleet/session/create", {
    ...(workspaceId ? { workspaceId } : {}), operationId: randomUUID(), ...(title ? { title } : {}),
    provider, context, ...(baseBranch ? { baseBranch } : {}), ...(yolo ? { yolo: true } : {}), ...configuration,
  }, sender) as AgentSnapshot
  if (snapshot.session?.lifecycle && snapshot.session.lifecycle !== "ready") throw new Error(snapshot.session.error ?? "Session provisioning failed")
  if (snapshot.session?.error) throw new Error(snapshot.session.error)
  if (prompt === undefined) return snapshot
  await agents.handle("_deskfleet/input/submit", { sessionId: snapshot.session.id, operationId: randomUUID(), content: [{ type: "text", text: prompt }], delivery: "backlog" }, sender)
  return agents.handle("_deskfleet/session/subscribe", { sessionId: snapshot.session.id }, actor)
}

export async function sendMcpSession(agents: MachineOperations["agents"], params: Record<string, unknown>, actor: AgentActor, sourceSuperAgent: boolean | undefined): Promise<unknown> {
  const { sessionId, prompt, delivery, turnId, provider, configuration } = validateSessionSend(params)
  const sender = mcpSender(actor, sourceSuperAgent)
  if (provider !== undefined) {
    const switched = await agents.handle("_deskfleet/session/switch-agent", { sessionId, operationId: randomUUID(), provider }, sender) as AgentSnapshot | undefined
    if (switched?.session?.error) throw new Error(switched.session.error)
  }
  if (hasConfigurationSelection(configuration)) {
    await agents.handle("_deskfleet/session/configure", { sessionId, operationId: randomUUID(), ...configuration }, sender)
  }
  return agents.handle("_deskfleet/input/submit", { sessionId, operationId: randomUUID(), content: [{ type: "text", text: prompt }], delivery, ...(turnId ? { turnId } : {}) }, sender)
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
  scheduleBridge?: McpScheduleBridge,
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
    if (!["machines", "machine", "providerConfiguration", "sessions", "session", "history", "sessionCreate", "sessionSend", "workspaceCreate", "mcpServers", "mcpTools", "mcpCall", "files", "fileUpload", "fileDownload"].includes(operation)) throw new Error("Unsupported remote MCP operation")
    if (!remote || actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("Remote Agent delegation is unavailable")
    const { machineId, ...args } = params
    if (operation !== "machines" && (typeof machineId !== "string" || !machineId)) throw new Error("A target machine is required")
    if (operation === "machines" && machineId !== undefined) throw new Error("Machine discovery takes no target")
    let remoteArgs = args
    if (operation === "providerConfiguration") validateProviderConfiguration(args)
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
    return method === "_deskfleet/input/submit" ? sendMcpSession(operations.agents, params, actor, source.session.superAgent) : operations.agents.handle(method, params, actor)
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
    return createMcpSession(operations.agents, normalized, actor, source.session.superAgent)
  }
  if (method === "providerList") return operations.providers.metadata()
  if (method === "_deskfleet/agent/configuration") {
    if (!crossWorkspace && params.workspaceId !== undefined && params.workspaceId !== scope.workspaceId) {
      throw new Error("Workspace is outside this MCP delegation")
    }
    const candidate = !machineOrSuperScope && params.workspaceId === undefined
      ? { ...params, workspaceId: scope.workspaceId }
      : params
    const parsed = validateProviderConfiguration(candidate)
    if (crossWorkspace && parsed.workspaceId !== undefined) {
      const catalog = await operations.catalog.native.snapshot()
      if (!catalog.workspaces.some(workspace => workspace.id === parsed.workspaceId)) {
        throw new Error(`Unknown Workspace: ${parsed.workspaceId}`)
      }
    }
    return queryMcpProviderConfiguration(operations.agents, candidate, actor)
  }
  if (method === "scheduleList") {
    const tasks = await operations.handle(method, {}, actor) as ScheduledTask[]
    return tasks.filter(task => task.workspaceId === scope.workspaceId)
  }
  if (method === "scheduleCreate") {
    if (scope.workspaceId === undefined) throw new Error("Schedules require a Workspace")
    const schedule = object(params.schedule)
    if (schedule.workspaceId !== undefined && schedule.workspaceId !== scope.workspaceId) throw new Error("Schedule is outside this MCP delegation")
    const bridged = await scheduleBridge?.prepareCreate?.({ actor, sessionId: scope.sessionId, workspaceId: scope.workspaceId, schedule })
    if (bridged?.duplicateOf) return bridged.duplicateOf
    const created = await operations.handle(method, {
      schedule: { ...schedule, workspaceId: scope.workspaceId },
      ...(bridged?.operationId ? { operationId: bridged.operationId } : {}),
      ...(bridged?.scheduleId ? { scheduleId: bridged.scheduleId } : {}),
    }, actor) as ScheduledTask
    if (bridged?.autoSubscribe) {
      await scheduleBridge?.onCreated?.({ actor, workspaceId: scope.workspaceId, task: created, deliveryPolicy: bridged.deliveryPolicy })
    }
    return created
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
  if (method === "_deskfleet/super-agent/workerReport") {
    if (!scheduleBridge?.reportFeedback) throw new Error("Super Agent reporting is unavailable for this session")
    return scheduleBridge.reportFeedback({ actor, sessionId: scope.sessionId, report: params })
  }
  throw new Error("This operation is unavailable through session MCP tools")
}
