import { readSystemStatus } from "./system-status.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import type { AgentActor, AgentMethod } from "./agent-protocol.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { DesktopCapabilities } from "./control-protocol.ts"
import { parseControlRequest } from "./control-request.ts"
import { listDirectories } from "./filesystem.ts"
import type { TerminalDial, TerminalSummary } from "./terminal-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"
import type { ProviderSetup } from "./provider-setup.ts"
import type { ScheduledTasks } from "./scheduled-tasks.ts"
import type { McpServers } from "./mcp-servers.ts"
import { mcpServerInput, validateMcpServerId } from "./mcp-server-protocol.ts"
import type { SystemStatus } from "./system-protocol.ts"

const MANAGEMENT = new Set<AgentMethod>([
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/archive", "_deskfleet/session/restore",
  "_deskfleet/session/list", "_deskfleet/session/subscribe", "_deskfleet/session/history", "_deskfleet/command/get",
])

/** The authenticated server selects the actor; request params never supply identity. */
export class MachineOperations {
  readonly agents: AgentSessions
  readonly catalog: DaemonCatalog
  readonly terminals: TerminalSessions
  readonly providers: AgentProviders
  readonly setup: ProviderSetup
  readonly schedules?: ScheduledTasks
  readonly mcpServers?: McpServers
  readonly #capabilities: () => Promise<DesktopCapabilities>
  readonly #systemStatus: () => Promise<SystemStatus>
  #workspaceMutations: Promise<unknown> = Promise.resolve()

  constructor(options: {
    agents: AgentSessions; catalog: DaemonCatalog; terminals: TerminalSessions
    providers: AgentProviders; setup: ProviderSetup; capabilities: () => Promise<DesktopCapabilities>
    schedules?: ScheduledTasks
    mcpServers?: McpServers
    systemStatus?: () => Promise<SystemStatus>
  }) {
    this.agents = options.agents; this.catalog = options.catalog; this.terminals = options.terminals
    this.providers = options.providers; this.setup = options.setup; this.#capabilities = options.capabilities
    this.schedules = options.schedules
    this.mcpServers = options.mcpServers
    this.#systemStatus = options.systemStatus ?? readSystemStatus
  }

  async dial(params: TerminalDial): Promise<TerminalSummary> {
    if (params.mode !== "create" || params.worktreeId === undefined) return this.terminals.dial(params)
    const worktree = (await this.catalog.native.snapshot()).workspaces.flatMap(workspace => workspace.worktrees).find(value => value.id === params.worktreeId)
    if (!worktree?.sessionId || !worktree.directories[0]) throw new Error("Session worktree is unavailable")
    return this.agents.withActiveSession(worktree.sessionId, () => this.terminals.dial({ ...params, cwd: params.cwd ?? worktree.directories[0]!.path }))
  }

  #workspaceMutation<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#workspaceMutations.catch(() => {}).then(action)
    this.#workspaceMutations = pending
    return pending
  }

  async handle(method: string, params: unknown, actor: AgentActor | undefined): Promise<unknown> {
    if (actor?.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and login session are required")
    if (["mcpServerList", "mcpServerCreate", "mcpServerUpdate", "mcpServerRemove"].includes(method)) {
      if (!this.mcpServers) throw new Error("MCP server settings are unavailable")
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected MCP server parameters")
      const input = params as Record<string, unknown>
      if (method === "mcpServerList") return this.mcpServers.snapshot()
      if (method === "mcpServerCreate") return this.mcpServers.create(mcpServerInput(input.server))
      validateMcpServerId(input.serverId)
      if (method === "mcpServerUpdate") return this.mcpServers.update(input.serverId, mcpServerInput(input.changes))
      await this.mcpServers.remove(input.serverId)
      return null
    }
    if (["scheduleList", "scheduleCreate", "scheduleUpdate", "scheduleDelete", "scheduleRun"].includes(method)) {
      if (!this.schedules) throw new Error("Scheduled tasks are unavailable")
      if (method === "scheduleCreate") return this.#workspaceMutation(() => this.schedules!.handle(method, params, actor))
      return this.schedules.handle(method, params, actor)
    }
    if (MANAGEMENT.has(method as AgentMethod)) return this.agents.handle(method as AgentMethod, params, actor)
    const request = parseControlRequest({ id: 0, method, params })
    switch (request.method) {
      case "catalogList":
      case "workspaceCreate":
      case "workspaceUpdate":
        return this.catalog.handle(request)
      case "workspaceDelete": {
        return this.#workspaceMutation(async () => {
          const schedules = await this.schedules?.handle("scheduleList", {}, actor) as { workspaceId: string }[] | undefined
          if (schedules?.some(schedule => schedule.workspaceId === request.params.workspaceId)) throw new Error("Remove this Workspace's scheduled tasks before deleting it")
          return this.catalog.handle(request)
        })
      }
      case "directoryList": return listDirectories(request.params.path)
      case "providerList": return this.providers.snapshot()
      case "providerCreate": return this.providers.create(request.params.provider)
      case "providerUpdate": return this.providers.update(request.params.providerId, request.params.changes)
      case "providerRemove": await this.providers.remove(request.params.providerId); return null
      case "providerTest": return this.providers.test(request.params.provider)
      case "providerProbe": return this.setup.probe(request.params.provider)
      case "providerInstall": return this.setup.install(request.params.provider)
      case "providerLogin": return this.setup.login(request.params.provider)
      case "capabilities": return this.#capabilities()
      case "systemStatus": return this.#systemStatus()
      case "terminalList": return this.terminals.list()
      case "terminalDial": return this.dial(request.params)
      case "terminalHangup": await this.terminals.hangup(request.params.terminalId); return null
      default: throw new Error("This operation is unavailable through machine management")
    }
  }
}
