import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostname } from "node:os"
import { AgentProviders } from "./agent-providers.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { CentralAgentQuotas, type AgentQuotaAuthority } from "./agent-quotas.ts"
import { AgentMcp } from "./agent-mcp.ts"
import { dispatchMcp } from "./mcp-dispatch.ts"
import { RemoteMcp } from "./remote-mcp.ts"
import { ScheduledTasks } from "./scheduled-tasks.ts"
import { McpServers } from "./mcp-servers.ts"
import type { AgentProvider } from "./agents/acp.ts"
import { DaemonCatalog } from "./catalog.ts"
import { CentralClient } from "./central-client.ts"
import { centralUrl, type CentralStatus, type EnrollmentTarget, type HostCentralStatus, type MachineEnrollment, type PreparedEnrollment } from "./central-protocol.ts"
import type { DesktopCapabilities } from "./control-protocol.ts"
import type { ControlPeers } from "./control-server.ts"
import { loadMachineRegistrations, newMachineDirectory, registrationKey, saveMachineRegistrations, type MachineRegistration } from "./machine-directory.ts"
import { MachineOperations } from "./machine-operations.ts"
import { ProviderSetup } from "./provider-setup.ts"
import { TerminalSessions } from "./terminals.ts"
import { WorktreeCleanup } from "./worktree-cleanup.ts"

interface MachineOptions {
  peers: ControlPeers
  capabilities: () => Promise<DesktopCapabilities>
  agentProvider?: AgentProvider
  agentQuotas?: AgentQuotaAuthority
  auvPath?: string
  terminals?: TerminalSessions
  allowLocalControlForTests?: boolean
  openCatalog?: Parameters<DaemonCatalog["init"]>[0]
}

async function openMachine(directory: string, hostDirectory: string, options: MachineOptions) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const catalog = new DaemonCatalog(directory, hostDirectory)
  const providers = new AgentProviders(directory, options.agentProvider, options.auvPath ? dirname(options.auvPath) : undefined)
  const mcpServers = new McpServers(directory, options.auvPath)
  const terminals = options.terminals ?? new TerminalSessions({ directory: join(directory, "terminals") })
  const setup = new ProviderSetup(terminals, { directory })
  let agents: AgentSessions | undefined
  let central: CentralClient | undefined
  let schedules: ScheduledTasks | undefined
  let mcp: AgentMcp | undefined
  let remoteMcp: RemoteMcp | undefined
  let cleanup: WorktreeCleanup | undefined
  let stopping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    const cleanupResults = await Promise.allSettled([cleanup?.close()])
    remoteMcp?.close()
    // Providers must close before awaiting a create/configure RPC they can unblock.
    const results = await Promise.allSettled([schedules?.close(), mcp?.close(), central?.stop(), agents?.close()])
    // Provider shutdown releases its ACP handles through the still-live terminal registry.
    const terminalResults = await Promise.allSettled([terminals.close()])
    const failures = [...cleanupResults, ...results, ...terminalResults].flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to stop machine resources")
  })()
  const close = () => closing ??= (async () => {
    try { await stop() }
    finally {
      try { await central?.close() }
      finally { await catalog.close() }
    }
  })()
  try {
    await catalog.init(options.openCatalog)
    catalog.onSessionRelease(worktreeId => terminals.hangupOwned(worktreeId))
    await providers.init()
    await mcpServers.init()
    let operations: MachineOperations
    const authorize = async (actor: Parameters<CentralClient["authorizeDelegation"]>[0]) => {
      if (!central) throw new Error("Machine delegation is not ready")
      return central.authorizeDelegation(actor)
    }
    mcp = new AgentMcp({
      servers: () => mcpServers.resolve(),
      authorize: async actor => { await authorize(actor) },
      dispatch: (method, params, actor, scope) => dispatchMcp(operations, method, params, actor, scope, request => central!.remoteMcp(request)),
    })
    await mcp.init()
    const quotas = options.agentQuotas ?? new CentralAgentQuotas((method, path, body) => {
      if (!central) throw new Error("Team allowance is unavailable")
      return central.quotaRequest(method, path, body)
    })
    agents = new AgentSessions(catalog, catalog.native, options.agentProvider, providers, mcp, terminals, quotas)
    await agents.init()
    await terminals.init()
    agents.onSessionArchive(worktreeId => terminals.stopOwned(worktreeId))
    void agents.resumeArchiving().catch(error => console.error("Could not resume Session archiving", error))
    schedules = new ScheduledTasks(directory, { agents, catalog, providers, authorize })
    await schedules.init()
    operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, mcpServers, capabilities: options.capabilities })
    remoteMcp = new RemoteMcp(hostDirectory, operations)
    central = new CentralClient(directory, operations, options.peers, undefined, remoteMcp)
    await central.init()
    cleanup = new WorktreeCleanup({ agents, catalog, pullRequest: (actor, query) => central!.githubPullRequest(actor, query) })
    cleanup.start()
    schedules.start()
    return { directory, catalog, providers, mcpServers, setup, agents, terminals, central, schedules, mcp, operations, stop, close }
  } catch (error) {
    try { await close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Machine startup and cleanup failed", { cause: error }) }
    throw error
  }
}

type Machine = Awaited<ReturnType<typeof openMachine>>

/** One host owns independent Team execution contexts and one stable enrollment identity. */
export class MachineRuntime {
  readonly #directory: string
  readonly #options: MachineOptions
  readonly #machines = new Map<string, { registration: MachineRegistration; machine: Machine }>()
  readonly #preparing = new Map<string, Promise<PreparedEnrollment>>()
  #initial: { directory: string; machine: Machine } | undefined
  #identityToken: string | undefined
  #changes: Promise<unknown> = Promise.resolve()
  #stopping: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(directory: string, options: MachineOptions) { this.#directory = directory; this.#options = options }

  /** Direct resource access for in-process fixtures; authenticated routing always names a Team. */
  get current(): Machine {
    const machine = this.#initial?.machine ?? this.#machines.values().next().value?.machine
    if (!machine) throw new Error("Machine service is not ready")
    return machine
  }

  /** The caller owns discovery before opening catalogs or migrating the registration index. */
  async init(): Promise<void> {
    const saved = await loadMachineRegistrations(this.#directory, this.#options.allowLocalControlForTests === true)
    this.#identityToken = saved.identityToken
    try {
      for (const registration of saved.registrations) {
        const machine = await openMachine(join(this.#directory, registration.directory), this.#directory, {
          ...this.#options, terminals: this.#machines.size ? undefined : this.#options.terminals,
        })
        const status = machine.central.status()
        if (status.configured && (status.serverUrl !== registration.serverUrl || status.teamId !== registration.teamId)) {
          await machine.close()
          throw new Error("Machine registration does not match its catalog credential")
        }
        this.#machines.set(registrationKey(registration), { registration, machine })
      }
      if (!this.#machines.size) this.#initial = {
        directory: saved.initialDirectory,
        machine: await openMachine(join(this.#directory, saved.initialDirectory), this.#directory, this.#options),
      }
    } catch (error) { await this.close(); throw error }
  }

  status(): HostCentralStatus {
    return { machineName: hostname(), registrations: [...this.#machines.values()].map(({ registration, machine }) => this.#status(registration, machine)) }
  }

  #status(registration: MachineRegistration, machine: Machine): CentralStatus {
    return { ...machine.central.status(), serverUrl: registration.serverUrl, teamId: registration.teamId }
  }

  forTeam(target: EnrollmentTarget): Machine {
    const entry = this.#machines.get(registrationKey(target))
    if (!entry) throw new Error("Prepare this Team's machine registration first")
    return entry.machine
  }

  forLocalChannel(teamId: string, machineId: string): CentralClient {
    const matches = [...this.#machines.values()].filter(({ registration, machine }) => registration.teamId === teamId && machine.central.status().machineId === machineId)
    if (matches.length !== 1) throw new Error("Local channel machine registration was not found")
    return matches[0]!.machine.central
  }

  prepareEnrollment(value: EnrollmentTarget): Promise<PreparedEnrollment> {
    if (this.#stopping) return Promise.reject(new Error("Machine service is stopping"))
    if (!this.#identityToken) return Promise.reject(new Error("Machine service is not ready"))
    const target = { serverUrl: centralUrl(value.serverUrl), teamId: value.teamId }
    if (!target.teamId) return Promise.reject(new Error("A Team is required for enrollment"))
    const key = registrationKey(target), pending = this.#preparing.get(key)
    if (pending) return pending
    const preparing = this.#changes.then(async () => {
      const existing = this.#machines.get(key)
      if (existing) return { ...this.#status(existing.registration, existing.machine), identityToken: this.#identityToken! }
      const directory = this.#initial?.directory ?? await newMachineDirectory(this.#directory)
      const machine = this.#initial?.machine ?? await openMachine(join(this.#directory, directory), this.#directory, { ...this.#options, terminals: undefined })
      const registration = { ...target, directory }
      try {
        await saveMachineRegistrations(this.#directory, [...this.#machines.values()].map(entry => entry.registration).concat(registration))
      } catch (error) {
        if (machine !== this.#initial?.machine) await machine.close()
        throw error
      }
      this.#machines.set(key, { registration, machine })
      this.#initial = undefined
      return { ...this.#status(registration, machine), identityToken: this.#identityToken! }
    }).finally(() => { this.#preparing.delete(key) })
    this.#changes = preparing.catch(() => {})
    this.#preparing.set(key, preparing)
    return preparing
  }

  enroll(value: MachineEnrollment): Promise<CentralStatus> {
    if (this.#stopping) return Promise.reject(new Error("Machine service is stopping"))
    const enrolling = this.#changes.then(async () => {
      const machine = this.forTeam(value)
      if (machine.central.status().identity.originId !== value.originId) throw new Error("Enrollment targets another catalog origin")
      const serverUrl = centralUrl(value.serverUrl)
      for (const { registration, machine: other } of this.#machines.values()) {
        const status = other.central.status()
        if (registration.serverUrl === serverUrl && status.machineId && status.machineId !== value.machineId) {
          throw new Error("Team registration must retain this host's machine identity")
        }
      }
      return machine.central.enroll({ ...value, serverUrl })
    })
    this.#changes = enrolling.catch(() => {})
    return enrolling
  }

  desktopCapabilitiesChanged(): void {
    for (const machine of this.#all()) machine.central.desktopCapabilitiesChanged()
  }

  #all(): Machine[] {
    return [...this.#machines.values()].map(entry => entry.machine).concat(this.#initial ? [this.#initial.machine] : [])
  }

  async #finish(action: "stop" | "close"): Promise<void> {
    const results = await Promise.allSettled(this.#all().map(machine => machine[action]()))
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, `Failed to ${action} machine registrations`)
  }

  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      await this.#changes
      await this.#finish("stop")
    })()
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      try { await this.stop() }
      finally { await this.#finish("close") }
    })()
  }
}
