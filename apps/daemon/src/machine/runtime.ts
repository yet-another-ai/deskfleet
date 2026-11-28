import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostname } from "node:os"
import type { CentralTransport } from "@deskfleet/client/central-transport"
import { inferDefaultDeliveryPolicy } from "@deskfleet/protocol/super-agent-follow-up"
import { SuperAttachmentStore } from "../super-agent/attachments.ts"
import { LocalFollowUpStore } from "../super-agent/follow-up-store.ts"
import { SuperFollowUpService } from "../super-agent/follow-up.ts"
import { createCoordinatorRuntime } from "../super-agent/provider.ts"
import type { routeSuperMessage } from "../super-agent/router.ts"
import { deterministicScheduleUuid } from "../super-agent/schedule.ts"
import { SuperAgentService, type SuperUserState } from "../super-agent/service.ts"
import { LocalSuperStore } from "../super-agent/store.ts"
import { createCoordinatorTriageModel } from "../super-agent/triage.ts"
import { superWorkspaces } from "../super-agent/workspaces.ts"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { CentralAgentQuotas, type AgentQuotaAuthority } from "../agent/quotas.ts"
import { AgentMcp } from "../agent/mcp.ts"
import { dispatchMcp } from "../mcp/dispatch.ts"
import { readRemoteAgentSettings } from "./host-settings.ts"
import { RemoteMcp } from "../mcp/remote.ts"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import { McpServers } from "../mcp/servers.ts"
import type { AgentProvider } from "../acp/connection.ts"
import { DaemonCatalog } from "./catalog.ts"
import { CentralClient } from "../central/client.ts"
import { centralUrl, type CentralStatus, type EnrollmentTarget, type HostCentralStatus, type MachineEnrollment, type PreparedEnrollment } from "@deskfleet/protocol/central"
import type { DesktopCapabilities } from "@deskfleet/protocol/control"
import type { ControlPeers } from "../control/server.ts"
import { loadMachineRegistrations, newMachineDirectory, registrationKey, saveMachineRegistrations, type MachineRegistration } from "./directory.ts"
import { MachineOperations } from "./operations.ts"
import { ProviderSetup } from "../providers/setup.ts"
import { ProviderUpdates } from "../providers/updates.ts"
import { TerminalSessions } from "../terminals/terminals.ts"
import { WorktreeCleanup } from "../worktrees/cleanup.ts"

interface MachineOptions {
  peers: ControlPeers
  capabilities: () => Promise<DesktopCapabilities>
  agentProvider?: AgentProvider
  superRoute?: typeof routeSuperMessage
  agentQuotas?: AgentQuotaAuthority
  auvPath?: string
  workspaceDirectory?: string
  terminals?: TerminalSessions
  allowLocalControlForTests?: boolean
  openCatalog?: Parameters<DaemonCatalog["init"]>[0]
  peerUpdates?: (current: ProviderUpdates) => Iterable<ProviderUpdates>
  centralTransport?: CentralTransport
}

async function openMachine(directory: string, hostDirectory: string, options: MachineOptions) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const catalog = new DaemonCatalog(directory, hostDirectory, options.workspaceDirectory)
  const providers = new AgentProviders(directory, options.agentProvider, options.auvPath ? dirname(options.auvPath) : undefined)
  const mcpServers = new McpServers(directory, options.auvPath)
  const terminals = options.terminals ?? new TerminalSessions({ directory: join(directory, "terminals") })
  const setup = new ProviderSetup(terminals, { directory })
  let agents: AgentSessions | undefined
  let central: CentralClient | undefined
  let frontDesk: SuperAgentService | undefined
  let followUp: SuperFollowUpService | undefined
  const coordinator = createCoordinatorRuntime(providers)
  let superStore: LocalSuperStore<SuperUserState> | undefined
  let followUpStore: LocalFollowUpStore | undefined
  let schedules: ScheduledTasks | undefined
  let providerUpdates: ProviderUpdates | undefined
  let mcp: AgentMcp | undefined
  let remoteMcp: RemoteMcp | undefined
  let cleanup: WorktreeCleanup | undefined
  let stopping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    const followUpStopped = followUp?.close()
    const frontDeskStopped = frontDesk?.close()
    const coordinatorStopped = coordinator.close()
    const cleanupResults = await Promise.allSettled([cleanup?.close()])
    remoteMcp?.close()
    // Providers must close before awaiting a create/configure RPC they can unblock.
    const results = await Promise.allSettled([followUpStopped, frontDeskStopped, coordinatorStopped, providerUpdates?.close(), schedules?.close(), mcp?.close(), central?.stop(), agents?.close()])
    // Provider shutdown releases its ACP handles through the still-live terminal registry.
    const terminalResults = await Promise.allSettled([terminals.close()])
    const failures = [...cleanupResults, ...results, ...terminalResults].flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to stop machine resources")
  })()
  const close = () => closing ??= (async () => {
    try { await stop() }
    finally {
      try { await central?.close() }
      finally { await superStore?.close(); await followUpStore?.close(); await catalog.close() }
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
      isSaWorkerSession: (sessionId, creationOperationId) => frontDesk?.isSaWorkerSession(sessionId, creationOperationId) === true,
      authorize: async actor => { await authorize(actor) },
      dispatch: (method, params, actor, scope) => dispatchMcp(
        operations, method, params, actor, scope,
        request => central!.remoteMcp(request),
        async () => (await readRemoteAgentSettings(hostDirectory)).allowLocalCrossWorkspace,
        {
          prepareCreate: async ({ actor: who, sessionId, workspaceId, schedule }) => {
            const delegation = frontDesk?.workerDelegationForSession(sessionId)
            if (!delegation || delegation.userId !== who.userId) return {}
            if (delegation.hasNativeScheduleId) {
              const existing = schedules?.snapshot().find(t => t.id === delegation.hasNativeScheduleId)
              if (existing) return { duplicateOf: existing }
            }
            const operationId = deterministicScheduleUuid("mcp-schedule-create", delegation.userId, workspaceId, delegation.sourceMessageId, String(schedule.title ?? ""), String(schedule.prompt ?? ""))
            const scheduleId = deterministicScheduleUuid("mcp-schedule-id", delegation.userId, workspaceId, delegation.sourceMessageId, String(schedule.title ?? ""), String(schedule.prompt ?? ""))
            const autoSubscribe = !!followUp
            return { operationId, scheduleId, autoSubscribe, deliveryPolicy: inferDefaultDeliveryPolicy(String(schedule.title ?? ""), String(schedule.prompt ?? "")) }
          },
          onCreated: async ({ actor: who, workspaceId, task, deliveryPolicy }) => {
            if (!who.userId || !followUp) return
            const active = followUp.isTakeoverActive(who.userId)
            await followUp.subscribeSchedule({
              userId: who.userId, workspaceId, scheduleId: task.id, scheduleTitle: task.title,
              targetKind: task.target.kind === "existing" ? "existing" : task.target.context,
              deliveryPolicy: deliveryPolicy ?? inferDefaultDeliveryPolicy(task.title, task.prompt),
              enabled: active,
              ...(active ? {} : { awaitingAuthorization: true }),
            })
          },
          reportFeedback: ({ actor: who, sessionId, report }) => {
            if (!frontDesk) throw new Error("Super Agent reporting is unavailable on this machine")
            return frontDesk.reportFromWorker(sessionId, report, who)
          },
        },
      ),
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
    // Load persisted follow-up grants & subscriptions BEFORE schedules.init() so startup recovery of
    // `claimed` -> `interrupted` runs immediately sees active SA subscribers!
    followUpStore = new LocalFollowUpStore(catalog.native)
    await followUpStore.init()
    const isScheduleSubscribed = (scheduleId: string, ownerUserId?: string): boolean => {
      if (followUp) return followUp.hasActiveScheduleSubscriber(scheduleId, ownerUserId)
      const sources = followUpStore!.listSources().filter(src => src.sourceKind === "schedule" && src.sourceId === scheduleId)
      const isTakeoverActive = (uid: string) => {
        const auth = followUpStore!.getAuth(uid)
        return !!auth && !auth.globalDisabled && auth.takeoverAllSessions === true && Object.values(auth.grants).some(grant => grant.enabled)
      }
      if (sources.some(src => src.state.enabled && !src.state.pausedReason && isTakeoverActive(src.userId))) return true
      if (ownerUserId && isTakeoverActive(ownerUserId) && !sources.some(src => src.userId === ownerUserId)) {
        return true
      }
      return false
    }
    const shouldEmitCreated = (ownerUserId: string): boolean => {
      if (followUp) return followUp.hasAdoptAllSchedules(ownerUserId)
      const auth = followUpStore!.getAuth(ownerUserId)
      return !!auth && !auth.globalDisabled && auth.takeoverAllSessions === true && Object.values(auth.grants).some(grant => grant.enabled)
    }
    schedules = new ScheduledTasks(directory, { agents, catalog, providers, authorize, isSubscribed: isScheduleSubscribed, shouldEmitCreated })
    await schedules.init()
    providerUpdates = new ProviderUpdates(providers, {
      probe: { directory },
      stopProviders: providerIds => agents!.stopProviders(providerIds),
      peers: () => options.peerUpdates?.(providerUpdates!) ?? [],
    })
    operations = new MachineOperations({ agents, catalog, providers, terminals, setup, providerUpdates, schedules, mcpServers, capabilities: options.capabilities })
    remoteMcp = new RemoteMcp(hostDirectory, operations)
    superStore = new LocalSuperStore<SuperUserState>(catalog.native)
    await superStore.init()
    const workspaceHelpers = superWorkspaces(catalog, directory)
    const defaultCoordinator = process.platform === "darwin" ? "codex" : "claude-code"
    const triageModel = createCoordinatorTriageModel({
      superStore,
      providers: () => providers.metadata().providers,
      defaultCoordinator,
      coordinatorModel: coordinator.model,
      coordinatorOptions: coordinator.options,
    })
    followUp = new SuperFollowUpService({
      followUpStore,
      superStore,
      agents,
      schedules,
      authorize,
      workspaces: workspaceHelpers.workspaces,
      historyCatalog: workspaceHelpers.historyCatalog,
      onCatalogChanged: listener => catalog.onChange(() => listener()),
      triageModel,
      githubPullRequest: (actor, query) => central!.githubPullRequest(actor, query),
      isInteractiveBusy: (uid, wid) => frontDesk?.isInteractiveBusy(uid, wid) ?? false,
      onRoomChanged: (uid, wid, sourceId) => frontDesk?.notifySnapshotDirty(uid, wid, sourceId),
    })
    const scheduleHost = {
      handleSchedule: (method: string, params: Record<string, unknown>, actor: Parameters<MachineOperations["handle"]>[2]) => operations.handle(method, params, actor),
      listSchedules: () => schedules!.snapshot(),
      subscribeSchedule: (params: Parameters<SuperFollowUpService["subscribeSchedule"]>[0]) => followUp!.subscribeSchedule(params).then(() => {}),
      setAdoptAllSchedules: (enabled: boolean, actor: Parameters<SuperFollowUpService["setAdoptAllSchedules"]>[1], opts?: Parameters<SuperFollowUpService["setAdoptAllSchedules"]>[2]) => followUp!.setAdoptAllSchedules(enabled, actor, opts),
      isFollowUpAuthorized: (uid: string) => followUp!.isTakeoverActive(uid),
      getScheduleSubscription: (uid: string, wid: string, sid: string) => followUp!.getScheduleSubscription(uid, wid, sid),
      listScheduleRuns: async (uid: string, wid: string, sid: string, limit?: number) => (await followUp!.listRuns({ userId: uid, workspaceId: wid, sourceKind: "schedule", sourceId: sid, limit })).runs,
      getScheduleRun: (uid: string, wid: string, sid: string, runId: string) => followUp!.getScheduleRun(uid, wid, sid, runId),
    }
    frontDesk = new SuperAgentService({
      coordinatorOptions: coordinator.options, coordinatorModel: coordinator.model,
      registration: () => central?.status(),
      defaultCoordinator,
      attachments: new SuperAttachmentStore(directory, (uid, path) => catalog.attachments.fileGrant(uid, path)),
      store: superStore, followUp, schedules: scheduleHost, agents, authorize, route: options.superRoute, ...workspaceHelpers,
      providers: () => providers.metadata().providers,
    })
    central = new CentralClient(directory, operations, options.peers, undefined, remoteMcp, options.centralTransport, frontDesk.handle.bind(frontDesk), frontDesk.subscribeFeedback.bind(frontDesk))
    const stopCentralReady = central.onReady(() => followUp?.notifyAuthorizeRecovered())
    await central.init()
    await followUp.init()
    await frontDesk.init()
    cleanup = new WorktreeCleanup({ agents, catalog, pullRequest: (actor, query) => central!.githubPullRequest(actor, query) })
    cleanup.start()
    schedules.start()
    providerUpdates.start()
    agents.startConfigurationCache()
    const baseClose = close
    const closeAll = () => {
      stopCentralReady()
      return baseClose()
    }
    return { directory, catalog, providers, mcpServers, setup, providerUpdates, agents, terminals, central, schedules, followUp, frontDesk, mcp, operations, stop, close: closeAll }
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

  constructor(directory: string, options: MachineOptions) {
    this.#directory = directory
    this.#options = {
      ...options,
      peerUpdates: current => this.#all().map(machine => machine.providerUpdates).filter(updates => updates !== current),
    }
  }

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
