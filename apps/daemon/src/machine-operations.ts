import type { AgentSessions } from "./agent-sessions.ts"
import type { AgentActor, AgentMethod } from "./agent-protocol.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { DesktopCapabilities } from "./control-protocol.ts"
import { parseControlRequest } from "./control-request.ts"
import { listDirectories } from "./filesystem.ts"
import type { TerminalDial, TerminalSummary } from "./terminal-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"

const MANAGEMENT = new Set<AgentMethod>([
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/create", "_deskfleet/session/archive", "_deskfleet/session/restore",
  "_deskfleet/session/list", "_deskfleet/session/subscribe", "_deskfleet/session/history", "_deskfleet/command/get",
])

/** The authenticated server selects the actor; request params never supply identity. */
export class MachineOperations {
  readonly agents: AgentSessions
  readonly catalog: DaemonCatalog
  readonly terminals: TerminalSessions
  readonly providers: AgentProviders
  readonly #capabilities: () => Promise<DesktopCapabilities>

  constructor(options: {
    agents: AgentSessions; catalog: DaemonCatalog; terminals: TerminalSessions
    providers: AgentProviders; capabilities: () => Promise<DesktopCapabilities>
  }) {
    this.agents = options.agents; this.catalog = options.catalog; this.terminals = options.terminals
    this.providers = options.providers; this.#capabilities = options.capabilities
  }

  async dial(params: TerminalDial): Promise<TerminalSummary> {
    if (params.mode !== "create" || params.worktreeId === undefined) return this.terminals.dial(params)
    const worktree = (await this.catalog.native.snapshot()).workspaces.flatMap(workspace => workspace.worktrees).find(value => value.id === params.worktreeId)
    if (!worktree?.sessionId || !worktree.directories[0]) throw new Error("Session worktree is unavailable")
    return this.agents.withActiveSession(worktree.sessionId, () => this.terminals.dial({ ...params, cwd: params.cwd ?? worktree.directories[0]!.path }))
  }

  async handle(method: string, params: unknown, actor: AgentActor | undefined): Promise<unknown> {
    if (actor?.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and login session are required")
    if (MANAGEMENT.has(method as AgentMethod)) return this.agents.handle(method as AgentMethod, params, actor)
    const request = parseControlRequest({ id: 0, method, params })
    switch (request.method) {
      case "catalogList":
      case "workspaceCreate":
      case "workspaceUpdate":
      case "workspaceDelete":
        return this.catalog.handle(request)
      case "directoryList": return listDirectories(request.params.path)
      case "providerList": return this.providers.snapshot()
      case "providerCreate": return this.providers.create(request.params.provider)
      case "providerUpdate": return this.providers.update(request.params.providerId, request.params.changes)
      case "providerRemove": await this.providers.remove(request.params.providerId); return null
      case "providerTest": return this.providers.test(request.params.provider)
      case "capabilities": return this.#capabilities()
      case "terminalList": return this.terminals.list()
      case "terminalDial": return this.dial(request.params)
      case "terminalHangup": await this.terminals.hangup(request.params.terminalId); return null
      default: throw new Error("This operation is unavailable through machine management")
    }
  }
}
