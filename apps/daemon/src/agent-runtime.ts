import { randomUUID } from "node:crypto"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { canContinueSession, supportsSteering, type AgentConfig, type AgentConnection, type AgentProvider } from "./agents/acp.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { AgentJournal, errorMessage, requireActiveSession, timestamp } from "./agent-store.ts"
import type { AgentCommand, AgentInput, AgentPermission, AgentRun, AgentSnapshot, AgentTurn } from "./agent-protocol.ts"

import { applyAgentConfiguration, readAgentConfiguration } from "./agent-configuration.ts"
import { agentConfiguration, type AgentConfiguration, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import { savedAgentConfiguration } from "./agent-session-configuration.ts"
import { withRestoredSessionMode } from "./agents/session-modes.ts"
import { AgentElicitations } from "./agent-elicitations.ts"
import type { AgentMcp, AgentMcpLease } from "./agent-mcp.ts"

const liveTurn = (turn: AgentTurn) => ["starting", "running", "cancelling"].includes(turn.state)
export type ResolveAgentProvider = (providerId: string) => { provider: AgentProvider; config: AgentConfig }
const systemCommand = async (journal: AgentJournal, sessionId: string, inputId: string): Promise<AgentCommand> => ({
  id: await journal.id(), operationId: randomUUID(), actor: { ...journal.actor(), kind: "system" },
  sessionId, method: "dispatch", params: { inputId }, isCanonical: true,
  status: "accepted", receivedAt: timestamp(),
})

/** One provider process, independent of all viewers of the durable Session. */
export class AgentRuntime {
  readonly journal: AgentJournal
  readonly sessionId: string
  readonly elicitations: AgentElicitations
  readonly #catalog: DaemonCatalog
  readonly #resolveProvider: ResolveAgentProvider
  readonly #mcp?: AgentMcp
  #mcpLease?: AgentMcpLease
  #providerName?: string
  #configuration?: acp.SessionConfigOption[]
  #availableConfiguration?: acp.SessionConfigOption[]
  #openingConfiguration = false
  #configurationEpoch = 0
  #configuring = false
  #forking = false
  #connection?: AgentConnection
  #run?: AgentRun
  #active?: { turn: AgentTurn; completion: Promise<void> }
  #endingTurn?: string
  #dispatching = false
  #pumpAgain = false
  #stopping = false
  #starting?: Promise<void>
  #stop?: Promise<void>
  #recovering?: Promise<void>
  #delivery?: Promise<void>
  readonly #permissions = new Map<string, (response: acp.RequestPermissionResponse) => void>()
  readonly #discoveries = new Set<{ controller: AbortController; signal: AbortSignal; pending: Promise<AgentConfiguration> }>()

  constructor(journal: AgentJournal, catalog: DaemonCatalog, resolveProvider: ResolveAgentProvider, sessionId: string, mcp?: AgentMcp) {
    this.journal = journal
    this.#catalog = catalog
    this.#resolveProvider = resolveProvider
    this.#mcp = mcp
    this.sessionId = sessionId
    this.elicitations = new AgentElicitations(journal, sessionId, () => ({
      generation: this.#run?.generation, turnId: this.#active?.turn.id,
      running: this.running && (!this.#active || this.#endingTurn !== this.#active.turn.id),
      connected: this.running,
    }))
  }

  get running(): boolean { return !!this.#connection && !this.#stopping && this.#run?.state === "running" }

  /** Capture a quiet conversation while new inputs remain in the backlog. */
  async withFork<T>(action: (snapshot: AgentSnapshot) => Promise<T>): Promise<T> {
    if (this.#forking || this.#configuring || this.#active || this.#dispatching) throw new Error("Wait for the current Agent operation before forking")
    this.#forking = true
    try {
      await this.#starting
      const snapshot = await this.journal.read(this.sessionId)
      requireActiveSession(snapshot.session)
      if (snapshot.session.lifecycle !== "ready" || !snapshot.session.providerSessionId) throw new Error("This Session has no conversation to fork")
      if (!snapshot.session.capabilities?.fork) throw new Error("The agent does not support session fork")
      if (snapshot.turns.some(liveTurn) || snapshot.permissions.some(row => row.state === "pending") || snapshot.elicitations.some(row => row.state === "pending")) throw new Error("Wait for the current turn and questions before forking")
      return await action(snapshot)
    } finally {
      this.#forking = false
      void this.pump()
    }
  }

  async configuration(signal?: AbortSignal): Promise<AgentConfiguration> {
    await this.#starting?.catch(() => {})
    signal?.throwIfAborted()
    const saved = await savedAgentConfiguration(this.journal, this.sessionId)
    const snapshot = await this.journal.read(this.sessionId)
    const providerId = snapshot.session.provider
    // Reading a removed provider's history remains possible. Only a new process
    // requires that its launch settings still exist.
    try { this.#providerName = this.#resolveProvider(providerId).config.name } catch {}
    const identity = { id: providerId, name: this.#providerName ?? providerId }
    if (snapshot.session.archiveState !== "active" || this.running || !snapshot.session.error) return agentConfiguration(this.#configuration ?? saved.options, identity)
    // Discover alternatives without resuming the failed conversation, changing
    // its saved selection, or releasing any pending inputs.
    let available: AgentConfiguration
    if (this.#availableConfiguration?.length) available = agentConfiguration(this.#availableConfiguration, identity)
    else {
      const previousStop = this.#stop
      await previousStop
      const catalog = await this.#catalog.native.snapshot()
      const worktree = catalog.workspaces.flatMap(workspace => workspace.worktrees).find(worktree => worktree.sessionId === this.sessionId)
      if (!worktree?.directories[0]) throw new Error("Session worktree is unavailable")
      const discovery = await this.journal.serial(this.sessionId, async () => {
        requireActiveSession((await this.journal.read(this.sessionId)).session)
        if (this.#stop === previousStop) {
          this.#stop = undefined
          this.#stopping = false
        }
        const controller = new AbortController()
        const discoverySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        const pending = readAgentConfiguration({ provider: providerId, ...saved.selection }, worktree.directories[0]!.path,
          { ...this.#resolveProvider(providerId), signal: discoverySignal, recoverSelection: true,
            onOptions: options => { this.#availableConfiguration = options },
          })
        const discovery = { controller, signal: discoverySignal, pending }
        this.#discoveries.add(discovery)
        return discovery
      })
      try { available = await discovery.pending }
      finally { this.#discoveries.delete(discovery) }
    }
    if (available.models && saved.selection.model !== undefined) available.models.currentValue = saved.selection.model
    if (available.reasoningEfforts && saved.selection.reasoningEffort !== undefined) available.reasoningEfforts.currentValue = saved.selection.reasoningEffort
    if (available.modes && saved.selection.mode !== undefined) available.modes.currentValue = saved.selection.mode
    return available
  }

  async configure(selection: AgentConfigurationSelection): Promise<AgentConfiguration> {
    requireActiveSession((await this.journal.read(this.sessionId)).session)
    if (this.#forking || this.#configuring || this.#active || this.#dispatching) throw new Error("Wait for the current turn before changing the Agent configuration")
    // Pause backlog dispatch through startup and every provider configuration call.
    this.#configuring = true
    this.#configurationEpoch++
    try {
      // A concurrent ordinary retry may still be trying the old choices. Wait
      // for it, then let this explicit replacement control the next startup.
      await this.#starting?.catch(() => {})
      await this.start(selection)
      const snapshot = await this.journal.read(this.sessionId)
      requireActiveSession(snapshot.session)
      if (this.#active || snapshot.turns.some(liveTurn)) throw new Error("Wait for the current turn before changing the Agent configuration")
      const sessionId = snapshot.session.providerSessionId!
      await applyAgentConfiguration(this.#connection!, sessionId, this.#configuration ?? [], selection,
        options => this.#recordConfiguration(sessionId, options))
      return this.configuration()
    } finally {
      this.#configuring = false
      void this.pump()
    }
  }

  async #recordConfiguration(sessionId: string, options: acp.SessionConfigOption[]): Promise<void> {
    const notification: acp.SessionNotification = { sessionId, update: { sessionUpdate: "config_option_update", configOptions: options } }
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      this.#configuration = options
      this.#availableConfiguration = options
      await this.journal.commit(snapshot, { events: [this.journal.event(this.sessionId, "acp", notification, { runGeneration: this.#run!.generation })] })
    })
  }

  async start(selection?: AgentConfigurationSelection, forkSource?: string): Promise<void> {
    requireActiveSession((await this.journal.read(this.sessionId)).session)
    if (this.#stopping && this.#stop) {
      const stopping = this.#stop
      return stopping.then(() => {
        if (this.#stop === stopping) {
          this.#stop = undefined
          this.#stopping = false
        }
        return this.start(selection, forkSource)
      })
    }
    if (this.#recovering) return this.#recovering.then(() => this.start(selection, forkSource))
    if (this.running) return Promise.resolve()
    if (this.#starting) return this.#starting
    this.#starting = this.#start(selection, forkSource).finally(() => { this.#starting = undefined })
    return this.#starting
  }

  async #start(selection?: AgentConfigurationSelection, forkSource?: string): Promise<void> {
    this.#stopping = false
    this.#stop = undefined
    this.#configurationEpoch++
    const snapshot = await this.journal.read(this.sessionId)
    requireActiveSession(snapshot.session)
    if (snapshot.session.lifecycle !== "ready" && !(forkSource && snapshot.session.lifecycle === "provisioning")) throw new Error("Session is not available for execution")
    await this.#active?.completion
    const savedConfiguration = await savedAgentConfiguration(this.journal, this.sessionId)
    // Changing models accepts the new model's default effort while preserving
    // the Session's mode. The provider can reconcile that mode with the model.
    const requested = selection?.model !== undefined
      ? { ...selection, mode: selection.mode ?? savedConfiguration.selection.mode }
      : { ...savedConfiguration.selection, ...selection }
    const availableConfiguration = this.#availableConfiguration
    this.#availableConfiguration = undefined
    const catalog = await this.#catalog.native.snapshot()
    const worktree = catalog.workspaces.flatMap(workspace => workspace.worktrees).find(worktree => worktree.sessionId === this.sessionId)
    if (!worktree?.directories[0]) throw new Error("Session worktree is unavailable")
    const run: AgentRun = {
      sessionId: this.sessionId, generation: Math.max(0, ...snapshot.runs.map(run => run.generation)) + 1,
      state: "starting", startedAt: timestamp(),
    }
    await this.journal.serial(this.sessionId, async () => {
      const current = await this.journal.read(this.sessionId)
      requireActiveSession(current.session)
      await this.journal.commit(current, { runs: [run], events: [this.journal.event(this.sessionId, "run", run)] })
    })
    this.#run = run
    try {
      // Resolve at process launch so edits apply to the next run, while an
      // existing process keeps the settings with which it was started.
      const { provider, config } = this.#resolveProvider(snapshot.session.provider)
      this.#providerName = config.name
      const connection = await provider.connect(config, {
        onUpdate: params => this.#update(params, run.generation),
        requestPermission: (params, signal) => this.#permission(params, signal, run.generation),
        requestElicitation: (params, signal) => this.elicitations.request(params, signal, run.generation),
        completeElicitation: params => this.elicitations.complete(params, run.generation),
        onClose: error => this.#connectionLost(error, run.generation),
      })
      this.#connection = connection
      if (this.#stopping) throw new Error("Agent startup was stopped")
      const capabilities = connection.initialization.agentCapabilities
      const additionalDirectories = worktree.directories.slice(1).map(directory => directory.path)
      if (additionalDirectories.length && !capabilities?.sessionCapabilities?.additionalDirectories) {
        throw new Error("This agent cannot use all of this Session's directories")
      }
      if (this.#mcp) {
        const creation = (await this.journal.commands(this.sessionId)).find(command => command.isCanonical && (command.method === "_deskfleet/session/create" || command.method === "_deskfleet/session/fork"))
        if (!creation) throw new Error("This Session has no initiating command for MCP delegation")
        this.#mcpLease = this.#mcp.lease(this.sessionId, snapshot.session.workspaceId, creation.actor)
        for (const server of this.#mcpLease.servers) {
          if ("type" in server && !capabilities?.mcpCapabilities?.[server.type]) {
            throw new Error(`This Agent does not support the ${server.type.toUpperCase()} transport required by MCP server "${server.name}". Change or disable that server in MCP Servers settings.`)
          }
        }
      }
      const params = { cwd: worktree.directories[0].path, mcpServers: this.#mcpLease?.servers ?? [], ...(additionalDirectories.length ? { additionalDirectories } : {}) }
      let providerSessionId = snapshot.session.providerSessionId
      let responseOptions: acp.SessionConfigOption[] | undefined
      this.#openingConfiguration = true
      try {
        if (forkSource) {
          if (!capabilities?.sessionCapabilities?.fork || !connection.forkSession) throw new Error("The agent does not support session fork")
          const forked = await connection.forkSession({ ...params, sessionId: forkSource })
          if (!forked.sessionId || forked.sessionId === forkSource) throw new Error("The agent did not create an independent fork")
          providerSessionId = forked.sessionId
          responseOptions = forked.configOptions ?? undefined
        } else if (providerSessionId) {
          if (!canContinueSession(connection.initialization)) throw new Error("This agent cannot resume the saved conversation")
          responseOptions = (await connection.resume({ ...params, sessionId: providerSessionId })).configOptions ?? undefined
        } else {
          const created = await connection.newSession(params)
          providerSessionId = created.sessionId
          responseOptions = created.configOptions ?? undefined
        }
      } finally {
        this.#openingConfiguration = false
      }
      // ACP may omit the catalog on resume, or return model options without modes.
      // Saved options still identify the setters, but their current values do not
      // describe this provider process.
      let configOptions = responseOptions === undefined
        ? this.#availableConfiguration ?? availableConfiguration ?? savedConfiguration.options
        : withRestoredSessionMode(responseOptions, savedConfiguration.options)
      this.#availableConfiguration = configOptions
      configOptions = await applyAgentConfiguration(connection, providerSessionId, configOptions, requested,
        options => { this.#availableConfiguration = options }, responseOptions === undefined)
      await this.#recordConfiguration(providerSessionId, configOptions)
      if (this.#stopping) throw new Error("Agent startup was stopped")
      run.state = "running"
      await this.journal.serial(this.sessionId, async () => {
        const current = await this.journal.read(this.sessionId)
        requireActiveSession(current.session)
        const session = {
          ...current.session, providerSessionId, lifecycle: "ready" as const, error: undefined, updatedAt: timestamp(),
          capabilities: { steering: supportsSteering(connection.initialization), resume: canContinueSession(connection.initialization), fork: !!capabilities?.sessionCapabilities?.fork && !!connection.forkSession },
        }
        await this.journal.commit(current, { session, runs: [run], events: [
          this.journal.event(this.sessionId, "session", session), this.journal.event(this.sessionId, "run", run),
        ] })
      })
      void this.pump()
    } catch (error) {
      this.#stopping = true
      this.#releaseMcp()
      await this.#connection?.close().catch(() => {})
      this.#connection = undefined
      run.state = "failed"
      run.error = errorMessage(error)
      run.endedAt = timestamp()
      await this.journal.serial(this.sessionId, async () => {
        const current = await this.journal.read(this.sessionId)
        const session = { ...current.session, error: run.error, updatedAt: timestamp() }
        await this.journal.commit(current, { session, runs: [run], events: [this.journal.event(this.sessionId, "run", run), this.journal.event(this.sessionId, "session", session)] })
      })
      throw error
    }
  }

  async #update(params: acp.SessionNotification, generation: number): Promise<void> {
    const configurationEpoch = this.#configurationEpoch
    if (params.update.sessionUpdate === "config_option_update") {
      if (this.#run?.generation !== generation || this.#stopping) return
      if (this.#openingConfiguration) {
        this.#availableConfiguration = params.update.configOptions
        return
      }
      // Check on receipt: journal work can run after startup or a setter has
      // finished. Its confirmed response must win over an earlier notification.
      if (this.#run.state !== "running" || this.#configuring) return
    }
    await this.journal.serial(this.sessionId, async () => {
      if (params.update.sessionUpdate === "config_option_update") {
        if (this.#run?.generation !== generation || this.#run.state !== "running" || this.#stopping
          || this.#configuring || configurationEpoch !== this.#configurationEpoch) return
        this.#configuration = params.update.configOptions
        this.#availableConfiguration = params.update.configOptions
      }
      const snapshot = await this.journal.read(this.sessionId)
      const turnId = this.#active?.turn.id
      const session = params.update.sessionUpdate === "session_info_update" && params.update.title
        ? { ...snapshot.session, title: params.update.title, updatedAt: timestamp() } : undefined
      const events = [this.journal.event(this.sessionId, "acp", params, { runGeneration: generation, turnId })]
      if (session) events.push(this.journal.event(this.sessionId, "session", session))
      await this.journal.commit(snapshot, { session, events })
    })
  }

  async #permission(request: acp.RequestPermissionRequest, signal: AbortSignal, generation: number): Promise<acp.RequestPermissionResponse> {
    const permission: AgentPermission = {
      id: await this.journal.id(), sessionId: this.sessionId, runGeneration: generation,
      turnId: this.#active?.turn.id, request, state: "pending", createdAt: timestamp(),
    }
    let resolve!: (response: acp.RequestPermissionResponse) => void
    const result = new Promise<acp.RequestPermissionResponse>(done => { resolve = done })
    this.#permissions.set(permission.id, resolve)
    try {
      await this.journal.serial(this.sessionId, async () => {
        const snapshot = await this.journal.read(this.sessionId)
        if (snapshot.session.archiveState !== "active") {
          permission.state = "cancelled"
          permission.resolvedAt = timestamp()
          resolve({ outcome: { outcome: "cancelled" } })
        }
        await this.journal.commit(snapshot, { permissions: [permission], events: [this.journal.event(this.sessionId, "permission", permission)] })
      })
      const abort = () => { void this.cancelPermissions(permission.id).catch(error => console.error("Permission cancellation failed", error)) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted || this.#stopping) abort()
      try { return await result } finally { signal.removeEventListener("abort", abort) }
    } finally { this.#permissions.delete(permission.id) }
  }

  resolvePermission(id: string, optionId: string): void {
    this.#permissions.get(id)?.({ outcome: { outcome: "selected", optionId } })
    this.#permissions.delete(id)
  }

  async cancelPermissions(id?: string, turnId?: string): Promise<void> {
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      const permissions = snapshot.permissions.filter(permission => permission.state === "pending" && (!id || permission.id === id) && (!turnId || permission.turnId === turnId))
        .map(permission => ({ ...permission, state: "cancelled" as const, resolvedAt: timestamp() }))
      if (permissions.length) await this.journal.commit(snapshot, { permissions, events: permissions.map(permission => this.journal.event(this.sessionId, "permission", permission)) })
      for (const permission of permissions) {
        this.#permissions.get(permission.id)?.({ outcome: { outcome: "cancelled" } })
        this.#permissions.delete(permission.id)
      }
    })
  }

  pump(): Promise<void> {
    if (!this.running || this.#active || this.#configuring || this.#forking) return Promise.resolve()
    if (this.#dispatching) {
      this.#pumpAgain = true
      return Promise.resolve()
    }
    this.#dispatching = true
    let launched = false
    const delivery = (async () => {
      try {
        const snapshot = await this.journal.read(this.sessionId)
        if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") return
        const input = snapshot.inputs.filter(input => input.state === "pending").sort((a, b) => Number(BigInt(a.acceptedSeq) - BigInt(b.acceptedSeq)))[0]
        if (input) {
          await this.#launch(input.id, await systemCommand(this.journal, this.sessionId, input.id))
          launched = true
        }
      } catch (error) { console.error("Agent dispatch failed", error) }
    })().finally(() => {
      this.#dispatching = false
      this.#delivery = undefined
      const again = this.#pumpAgain
      this.#pumpAgain = false
      if (launched || again) void this.pump()
    })
    this.#delivery = delivery
    return delivery
  }

  /** Returns on delivery, not when the active prompt finishes. */
  steer(inputId: string, command: AgentCommand, requestedTurnId?: string): Promise<void> {
    if (!this.running || !this.#connection) return Promise.reject(new Error("Resume the Agent before steering"))
    if (this.#configuring || this.#forking) return Promise.reject(new Error("Wait for the current Agent operation before steering"))
    if (this.#dispatching) return Promise.reject(new Error("Another input is being delivered; retry after it is accepted"))
    this.#dispatching = true
    const delivery = this.#steer(inputId, command, requestedTurnId).finally(() => {
      this.#dispatching = false
      this.#delivery = undefined
      this.#pumpAgain = false
      void this.pump()
    })
    this.#delivery = delivery
    return delivery
  }

  async #steer(inputId: string, command: AgentCommand, requestedTurnId?: string): Promise<void> {
    let sent = false
    try {
      const active = this.#active
      if (active && requestedTurnId && active.turn.id !== requestedTurnId) throw new Error("The selected turn has already ended")
      if (!active) {
        await this.#launch(inputId, command, true)
        return
      }
      const connection = this.#connection!
      if (!supportsSteering(connection.initialization)) throw new Error("This agent does not support steering")
      const input = await this.journal.serial(this.sessionId, async () => {
        const snapshot = await this.journal.read(this.sessionId)
        const input = this.#claim(snapshot, inputId, command, true)
        await this.journal.commit(snapshot, { inputs: [input], command, events: [this.journal.event(this.sessionId, "input", input)] })
        return input
      })
      const snapshot = await this.journal.read(this.sessionId)
      requireActiveSession(snapshot.session)
      if (!this.running) throw new Error("Agent stopped before delivery")
      sent = true
      const result = await connection.steer({ sessionId: snapshot.session.providerSessionId!, prompt: input.content }, command.id)
      if (result.outcome === "inactive") {
        await active.completion
        if (!this.running) throw new Error("The Agent stopped before this input could start")
        await this.#launch(inputId, command, true)
      } else {
        await this.#delivered(inputId, command, active.turn.id, "steer")
      }
    } catch (error) {
      await this.#inputError(inputId, command, error, sent)
      throw error
    }
  }

  #claim(snapshot: AgentSnapshot, inputId: string, command: AgentCommand, alreadyClaimed = false): AgentInput {
    requireActiveSession(snapshot.session)
    const input = snapshot.inputs.find(input => input.id === inputId)
    if (!input || (input.state !== "pending" && !(alreadyClaimed && input.state === "dispatching" && input.dispatchCommandId === command.id))) {
      throw new Error("This input has already been handled")
    }
    return { ...input, state: "dispatching", dispatchCommandId: command.id, dispatcher: command.actor, error: undefined }
  }

  async #launch(inputId: string, command: AgentCommand, alreadyClaimed = false): Promise<void> {
    if (!this.running || !this.#connection || !this.#run || this.#active) throw new Error("Agent is not ready for a new turn")
    const connection = this.#connection
    const turn: AgentTurn = {
      id: await this.journal.id(), sessionId: this.sessionId, initialInputId: inputId, dispatchCommandId: command.id,
      runGeneration: this.#run.generation, state: "running", startedAt: timestamp(),
    }
    const input = await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      if (!this.running || snapshot.session.lifecycle !== "ready") throw new Error("Agent is stopping")
      if (snapshot.turns.some(liveTurn)) throw new Error("The current turn has not finished")
      const input = { ...this.#claim(snapshot, inputId, command, alreadyClaimed), turnId: turn.id, actualDelivery: "turn_start" as const }
      await this.journal.commit(snapshot, { inputs: [input], turns: [turn], command, events: [
        this.journal.event(this.sessionId, "input", input), this.journal.event(this.sessionId, "turn", turn),
      ] })
      return input
    })
    const snapshot = await this.journal.read(this.sessionId)
    if (snapshot.session.archiveState !== "active" || !this.running || this.#connection !== connection) {
      await this.#finish(turn, inputId, command, undefined, new Error("Agent stopped before delivery"), false)
      return
    }
    let done!: () => void
    const completion = new Promise<void>(resolve => { done = resolve })
    this.#active = { turn, completion }
    void connection.prompt({ sessionId: snapshot.session.providerSessionId!, prompt: input.content }).then(
      result => this.#finish(turn, inputId, command, result),
      error => this.#finish(turn, inputId, command, undefined, error),
    ).catch(error => console.error("Could not persist Agent turn completion", error)).finally(() => {
      if (this.#active?.turn.id === turn.id) this.#active = undefined
      done()
      void this.pump()
    })
  }

  async #delivered(inputId: string, command: AgentCommand, turnId: string, delivery: "steer" | "turn_start"): Promise<void> {
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      const previous = snapshot.inputs.find(input => input.id === inputId)
      if (!previous || previous.dispatchCommandId !== command.id) return
      const input: AgentInput = { ...previous, state: "delivered", turnId, actualDelivery: delivery, deliveredAt: timestamp() }
      const completed = { ...command, status: "completed" as const, completedAt: timestamp(), result: {
        operationId: command.operationId, commandId: command.id, sessionId: this.sessionId, inputId, turnId, delivery,
      } }
      await this.journal.commit(snapshot, { inputs: [input], command: completed, events: [this.journal.event(this.sessionId, "input", input)] })
    })
  }

  async #inputError(inputId: string, command: AgentCommand, error: unknown, uncertain = true): Promise<void> {
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      const previous = snapshot.inputs.find(input => input.id === inputId)
      if (!previous || previous.dispatchCommandId !== command.id) return
      const state = uncertain ? "uncertain" : "failed"
      const input: AgentInput = { ...previous, state, error: errorMessage(error) }
      await this.journal.commit(snapshot, { inputs: [input], command: { ...command, status: state, error: input.error, completedAt: timestamp() }, events: [this.journal.event(this.sessionId, "input", input)] })
    })
  }

  async #finish(turn: AgentTurn, inputId: string, command: AgentCommand, result?: acp.PromptResponse, error?: unknown, uncertain = true): Promise<void> {
    this.#endingTurn = turn.id
    await this.cancelPermissions(undefined, turn.id)
    await this.elicitations.cancel(undefined, turn.id)
    if (result) await this.#delivered(inputId, command, turn.id, "turn_start")
    else await this.#inputError(inputId, command, error, uncertain)
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      const current = snapshot.turns.find(value => value.id === turn.id)
      if (!current || !liveTurn(current)) return
      const finished: AgentTurn = {
        ...current, state: error ? "interrupted" : result?.stopReason === "cancelled" ? "cancelled" : "completed",
        endedAt: timestamp(), stopReason: result?.stopReason, error: error ? errorMessage(error) : undefined,
      }
      await this.journal.commit(snapshot, { turns: [finished], events: [this.journal.event(this.sessionId, "turn", finished)] })
    })
  }

  async cancel(turnId: string): Promise<void> {
    if (this.#active?.turn.id !== turnId || !this.#connection) return
    const connection = this.#connection
    const snapshot = await this.journal.read(this.sessionId)
    if (this.#active?.turn.id !== turnId) return
    this.#endingTurn = turnId
    await this.cancelPermissions(undefined, turnId)
    await this.elicitations.cancel(undefined, turnId)
    if (this.#active?.turn.id === turnId && this.#connection === connection) await connection.cancel(snapshot.session.providerSessionId!)
  }

  #connectionLost(error: Error, generation: number): void {
    if (this.#run?.generation !== generation || this.#stopping) return
    this.#releaseMcp()
    this.#connection = undefined
    const recovery = this.#lost(error, generation).catch(error => console.error("Agent recovery failed", error)).finally(() => {
      if (this.#recovering === recovery) this.#recovering = undefined
    })
    this.#recovering = recovery
  }

  async #lost(error: Error, generation: number): Promise<void> {
    await this.cancelPermissions()
    await this.elicitations.cancel()
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      const previous = snapshot.runs.find(run => run.generation === generation)
      if (!previous || !["starting", "running"].includes(previous.state)) return
      const run: AgentRun = { ...previous, state: "interrupted", endedAt: timestamp(), error: error.message }
      if (this.#run?.generation === generation) this.#run = run
      await this.journal.commit(snapshot, { runs: [run], events: [this.journal.event(this.sessionId, "run", run)] })
    })
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop
    const stopping = this.#stopRun()
    this.#stop = stopping
    void stopping.catch(() => { if (this.#stop === stopping) this.#stop = undefined })
    return stopping
  }
  async #stopRun(): Promise<void> {
    this.#stopping = true
    this.#releaseMcp()
    const discoveries = [...this.#discoveries]
    for (const discovery of discoveries) discovery.controller.abort(new Error("Agent configuration discovery was stopped"))
    // Startup can be awaiting session/new or resume. Closing its connection
    // must be able to reject that RPC before we wait for startup to finish.
    if (this.#starting) await this.#connection?.close()
    await this.#starting?.catch(() => {})
    this.#releaseMcp()
    await Promise.all(discoveries.map(async discovery => {
      try { await discovery.pending }
      catch (error) { if (error !== discovery.signal.reason) throw error }
    }))
    await this.#recovering
    await this.cancelPermissions()
    await this.elicitations.cancel()
    const connection = this.#connection
    if (this.#active) await this.cancel(this.#active.turn.id)
    await connection?.close()
    await this.#delivery?.catch(() => {})
    await this.#active?.completion
    this.#connection = undefined
    await this.journal.serial(this.sessionId, async () => {
      const snapshot = await this.journal.read(this.sessionId)
      if (!this.#run) return
      this.#run = { ...this.#run, state: "stopped", endedAt: timestamp() }
      await this.journal.commit(snapshot, { runs: [this.#run], events: [this.journal.event(this.sessionId, "run", this.#run)] })
    })
  }

  #releaseMcp(): void {
    this.#mcpLease?.close()
    this.#mcpLease = undefined
  }
}
