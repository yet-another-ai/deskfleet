import type { AgentQuotaAuthority } from "./agent-quotas.ts"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type { NativePeer, PeerConfig } from "@deskfleet/native"
import { readSystemStatus } from "./system-status.ts"
import { desktopCapabilities, supportsDesktop } from "./desktop-capabilities.ts"
import { daemonDiscoveryPath, readDaemonDiscovery } from "./control-discovery.ts"
import { MAX_CONTROL_MESSAGE_BYTES, desktopErrorEvent, desktopStartupCleanupFailure, encoderFailure, isEncoderFailure, type ControlMessage, type ControlRequest, type DaemonDiscovery, type DesktopCapabilities, type DesktopEvent } from "./control-protocol.ts"
import { parseControlRequest, readControlRequestId } from "./control-request.ts"
import { endControlSocket } from "./control-socket.ts"
import { TerminalChannel } from "./terminal-channel.ts"
import { TERMINAL_CHANNEL } from "./terminal-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { listDirectories } from "./filesystem.ts"
import { DesktopPermissions } from "./desktop-permissions.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import { AgentChannel } from "./agent-channel.ts"
import { AGENT_CHANNEL } from "./agent-protocol.ts"
import type { AgentProvider } from "./agents/acp.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { ProviderSetup } from "./provider-setup.ts"
import type { CentralClient } from "./central-client.ts"
import { MachineRuntime } from "./machine-runtime.ts"
import type { CentralStatus } from "./central-protocol.ts"
import { DesktopInputChannel, DESKTOP_INPUT_CHANNEL } from "./desktop-input.ts"

/** The daemon's ownership surface, injectable without screen capture in tests. */
export interface ControlPeers {
  create(id: string, config: PeerConfig): Promise<NativePeer>
  close(id: string): Promise<void>
}

type Capabilities = () => Promise<DesktopCapabilities>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface OwnedPeer {
  nativeId: string
  peer: Promise<NativePeer>
  terminal?: TerminalChannel
  agent?: AgentChannel
  input?: DesktopInputChannel
  desktopStart?: "starting" | "started"
}

interface LocalDelivery {
  peerId: string
  finish(error?: Error): void
}

class ControlConnection {
  readonly #socket: Socket
  readonly #token: string
  readonly #peers: ControlPeers
  readonly #capabilities: Capabilities
  readonly #terminals: TerminalSessions
  readonly #catalog: DaemonCatalog
  readonly #permissions: DesktopPermissions
  readonly #agents: () => AgentSessions
  readonly #providers: AgentProviders
  readonly #setup: ProviderSetup
  readonly #onShutdownRequested: (() => void) | undefined
  readonly #central: () => CentralClient
  readonly #prepareEnrollment: () => Promise<CentralStatus>
  readonly #allowLocalControlForTests: boolean
  readonly #sessions = new Map<string, OwnedPeer>()
  readonly #closingSessions = new Map<string, Promise<void>>()
  readonly #localPeers = new Map<string, CentralClient>()
  readonly #localDeliveries = new Map<number, LocalDelivery>()
  #nextLocalSequence = 0
  #localDeliveryBytes = 0
  readonly #dialed = new Set<string>()
  readonly #unsubscribe: () => void
  #authenticated = false
  #closing: Promise<void> | undefined

  constructor(socket: Socket, token: string, peers: ControlPeers, capabilities: Capabilities, terminals: TerminalSessions, catalog: DaemonCatalog, permissions: DesktopPermissions, agents: () => AgentSessions, providers: AgentProviders, setup: ProviderSetup, central: () => CentralClient, prepareEnrollment: () => Promise<CentralStatus>, allowLocalControlForTests: boolean, onShutdownRequested?: () => void) {
    this.#socket = socket
    this.#token = token
    this.#peers = peers
    this.#capabilities = capabilities
    this.#terminals = terminals
    this.#catalog = catalog
    this.#permissions = permissions
    this.#agents = agents
    this.#providers = providers
    this.#setup = setup
    this.#onShutdownRequested = onShutdownRequested
    this.#central = central
    this.#prepareEnrollment = prepareEnrollment
    this.#allowLocalControlForTests = allowLocalControlForTests
    const unsubscribeTerminals = allowLocalControlForTests ? terminals.onChange(event => {
      if (event.kind === "terminalHungup") this.#dialed.delete(event.terminalId)
      if (this.#authenticated) this.#send({ event })
    }) : () => {}
    const unsubscribeCatalog = allowLocalControlForTests ? catalog.onChange(event => {
      if (this.#authenticated) this.#send({ event })
    }) : () => {}
    const unsubscribePermissions = permissions.onChange(permissions => {
      if (this.#authenticated) this.#send({ event: { kind: "desktopPermissionsChanged", permissions } })
    })
    const unsubscribeProviders = allowLocalControlForTests ? providers.onChanged(() => {
      if (this.#authenticated) this.#send({ event: { kind: "providersChanged" } })
    }) : () => {}
    this.#unsubscribe = () => { unsubscribeTerminals(); unsubscribeCatalog(); unsubscribePermissions(); unsubscribeProviders() }
    socket.on("error", () => {})
    socket.once("close", () => { void this.close().catch(error => console.error("Desktop session cleanup failed", error)) })
  }

  #send(value: ControlMessage): void {
    if (this.#socket.destroyed || this.#socket.writableEnded) return
    const data = JSON.stringify(value) + "\n"
    // Bound an already-stalled client's queue, while allowing one catalog
    // snapshot to exceed the per-request size limit.
    if (this.#socket.writableLength > MAX_CONTROL_MESSAGE_BYTES * 4) {
      this.#socket.destroy()
      return
    }
    this.#socket.write(data)
  }

  #sendLocal(peerId: string, data: Buffer, isString: boolean): Promise<void> {
    if (this.#closing || this.#socket.destroyed || this.#socket.writableEnded) return Promise.reject(new Error("Local channel connection closed"))
    const sequence = ++this.#nextLocalSequence
    const line = JSON.stringify({ event: { kind: "localChannelMessage", peerId, sequence, data: data.toString(isString ? "utf8" : "base64"), isString } }) + "\n"
    const bytes = Buffer.byteLength(line)
    if (this.#socket.writableLength + bytes > MAX_CONTROL_MESSAGE_BYTES * 4 || this.#localDeliveryBytes + bytes > MAX_CONTROL_MESSAGE_BYTES * 4) {
      return Promise.reject(new Error("Local channel backpressure: send buffer is full"))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Local channel delivery acknowledgement timed out")), 5_000)
      const finish = (error?: Error) => {
        if (!this.#localDeliveries.delete(sequence)) return
        this.#localDeliveryBytes -= bytes
        clearTimeout(timeout)
        if (error) reject(error); else resolve()
      }
      this.#localDeliveryBytes += bytes
      this.#localDeliveries.set(sequence, { peerId, finish })
      this.#socket.write(line, error => { if (error) finish(error) })
    })
  }

  #closeLocalDeliveries(peerId?: string): void {
    for (const delivery of this.#localDeliveries.values()) {
      if (peerId === undefined || delivery.peerId === peerId) delivery.finish(new Error("Local channel connection closed"))
    }
  }

  async run(): Promise<void> {
    let pending = Buffer.alloc(0)
    try {
      for await (const data of this.#socket) {
        pending = Buffer.concat([pending, data as Buffer])
        for (;;) {
          const end = pending.indexOf(10)
          if (end < 0) break
          if (end > MAX_CONTROL_MESSAGE_BYTES) throw new Error("Local daemon request is too large")
          const value: unknown = JSON.parse(pending.subarray(0, end).toString("utf8"))
          const id = readControlRequestId(value)
          pending = pending.subarray(end + 1)
          try {
            const request = parseControlRequest(value)
            if (["providerTest", "providerProbe", "providerInstall", "providerLogin"].includes(request.method) && this.#authenticated) {
              // Probes and setup can take seconds; keep terminal I/O and other requests responsive.
              void this.#handle(request).then(
                result => this.#send({ id: request.id, result }),
                error => this.#send({ id: request.id, error: message(error) }),
              )
              continue
            }
            const result = await this.#handle(request)
            if (request.method === "shutdown") {
              // Flush the acknowledgement before shutdown closes client sockets.
              await endControlSocket(this.#socket, JSON.stringify({ id: request.id, result }) + "\n")
              this.#onShutdownRequested?.()
              return
            }
            this.#send({ id: request.id, result })
          } catch (error) {
            this.#send({ id, error: message(error), ...(isEncoderFailure(error) ? { reason: "encoder" as const } : {}) })
            if (!this.#authenticated) {
              await endControlSocket(this.#socket)
              return
            }
          }
          if (this.#socket.destroyed) return
        }
        if (pending.length > MAX_CONTROL_MESSAGE_BYTES) throw new Error("Local daemon request is too large")
      }
    } catch {
      // Malformed framing and socket errors terminate only this client's sessions.
      this.#socket.destroy()
    } finally {
      await this.close()
    }
  }

  async #handle(request: ControlRequest): Promise<unknown> {
    if (request.method === "hello") {
      const received = Buffer.from(request.params.token)
      const expected = Buffer.from(this.#token)
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Local daemon authentication failed")
      this.#authenticated = true
      return {
        name: hostname(),
        desktop: await supportsDesktop(),
        ...await this.#permissions.readState(),
      }
    }
    if (!this.#authenticated) throw new Error("Authenticate with the local daemon first")
    if (this.#closing) throw new Error("Local daemon connection is closed")
    if (!this.#allowLocalControlForTests && !["shutdown", "capabilities", "centralStatus", "centralEnroll", "centralPrepareEnrollment", "permissionsRefresh", "permissionRequest", "localOpen", "localSend", "localAck", "localClose"].includes(request.method)) {
      throw new Error("Sign in and select a team; manage machine resources through the backend API")
    }
    switch (request.method) {
      case "permissionsRefresh": return this.#permissions.refresh()
      case "permissionRequest": return this.#permissions.requestPermission(request.params.permission)
      case "centralStatus": return this.#central().status()
      case "centralPrepareEnrollment": return this.#prepareEnrollment()
      case "centralEnroll": return this.#central().enroll(request.params)
      case "localOpen": {
        const { peerId, token } = request.params
        if (this.#localPeers.size >= 16) throw new Error("Too many local channels on this connection")
        const central = this.#central()
        central.openLocal(peerId, token, this, {
          send: (data, isString) => this.#sendLocal(peerId, data, isString),
          close: error => {
            this.#localPeers.delete(peerId)
            this.#closeLocalDeliveries(peerId)
            this.#send({ event: { kind: "localChannelClosed", peerId, ...(error ? { error } : {}) } })
          },
        })
        this.#localPeers.set(peerId, central)
        return null
      }
      case "localSend": {
        const { peerId, data, isString } = request.params
        const central = this.#localPeers.get(peerId)
        if (!central) throw new Error("Unknown local channel on this connection")
        central.sendLocal(peerId, this, Buffer.from(data, isString ? "utf8" : "base64"), isString)
        return null
      }
      case "localClose": {
        const { peerId } = request.params
        await this.#localPeers.get(peerId)?.closeLocal(peerId, this)
        return null
      }
      case "localAck": {
        const delivery = this.#localDeliveries.get(request.params.sequence)
        if (delivery?.peerId === request.params.peerId) delivery.finish()
        return null
      }
      case "providerList":
        return this.#providers.snapshot()
      case "providerCreate":
        return this.#providers.create(request.params.provider)
      case "providerUpdate":
        return this.#providers.update(request.params.providerId, request.params.changes)
      case "providerRemove":
        await this.#providers.remove(request.params.providerId)
        return null
      case "providerTest":
        return this.#providers.test(request.params.provider)
      case "providerProbe":
        return this.#setup.probe(request.params.provider)
      case "providerInstall":
        return this.#setup.install(request.params.provider)
      case "providerLogin":
        return this.#setup.login(request.params.provider)
      case "shutdown":
        if (!this.#onShutdownRequested) throw new Error("Daemon shutdown is unavailable")
        return null
      case "directoryList":
        return listDirectories(request.params.path)
      case "catalogList":
      case "workspaceCreate":
      case "workspaceUpdate":
      case "workspaceDelete":
      case "workspaceSessionCreate":
        return this.#catalog.handle(request)
      case "workspaceSessionDestroy": {
        const managed = (await this.#agents().journal.list()).some(session => session.id === request.params.sessionId)
        if (managed) throw new Error("Delete Agent Sessions through the Agent Session service")
        return this.#catalog.handle(request)
      }
      case "capabilities":
        return this.#capabilities()
      case "systemStatus":
        return readSystemStatus()
      case "terminalList":
        return this.#terminals.list()
      case "terminalDial": {
        let params = request.params
        if (params.mode === "create" && params.worktreeId !== undefined) {
          const { worktreeId } = params
          const worktree = (await this.#catalog.native.snapshot()).workspaces.flatMap(workspace => workspace.worktrees).find(value => value.id === worktreeId)
          if (!worktree?.sessionId || !worktree.directories[0]) throw new Error("Session worktree is unavailable")
          params = { ...params, cwd: params.cwd ?? worktree.directories[0].path }
        }
        const terminal = await this.#terminals.dial(params)
        this.#dialed.add(terminal.id)
        return terminal
      }
      case "terminalHangup":
        await this.#terminals.hangup(request.params.terminalId)
        return null
      case "offer":
      case "terminalOffer":
      case "agentOffer": {
        const { sessionId, sdp } = request.params
        if (this.#sessions.has(sessionId) || this.#closingSessions.has(sessionId)) throw new Error("Desktop session already exists")
        if (this.#sessions.size >= 8) throw new Error("Too many desktop sessions")
        const config: PeerConfig = request.method === "offer" ? { video: request.params.codec, audio: request.params.audio } : {}
        if (config.audio && process.platform !== "darwin") throw new Error("System audio capture is unavailable on this platform")
        const nativeId = randomUUID()
        const owned: OwnedPeer = { nativeId, peer: this.#peers.create(nativeId, config) }
        this.#sessions.set(sessionId, owned)
        try {
          const peer = await owned.peer
          if (request.method === "offer") owned.input = new DesktopInputChannel(peer, () => {
            if (this.#sessions.get(sessionId) !== owned || this.#closing) throw new Error("Desktop session is closed")
          })
          if (request.method === "terminalOffer") {
            owned.terminal = new TerminalChannel(
              this.#terminals,
              text => peer.sendText(TERMINAL_CHANNEL, text),
              error => {
                this.#send({ event: { sessionId, kind: "error", error: message(error) } })
                void this.#closeSession(sessionId).catch(cleanup => console.error("Terminal peer cleanup failed", cleanup))
              },
              id => this.#dialed.has(id),
            )
          }
          if (request.method === "agentOffer") {
            const agents = this.#agents()
            owned.agent = new AgentChannel(agents, agents.actor(), bytes => peer.sendData(AGENT_CHANNEL, Buffer.from(bytes)), error => {
              this.#send({ event: { sessionId, kind: "error", error: message(error) } })
              void this.#closeSession(sessionId).catch(cleanup => console.error("Agent peer cleanup failed", cleanup))
            })
          }
          void this.#events(sessionId, owned, peer)
          return { sdp: await peer.answerOffer(sdp) }
        } catch (error) {
          await this.#closeSession(sessionId)
          throw error
        }
      }
      case "candidate":
        await (await this.#session(request.params.sessionId)).addIceCandidate(request.params.candidate)
        return null
      case "start": {
        const { sessionId, displayId, fps, bitrateBps, control } = request.params
        const owned = this.#sessions.get(sessionId)
        if (!owned) throw new Error("Unknown desktop session on this connection")
        if (owned.terminal || owned.agent) throw new Error("Data-only peers cannot start desktop capture")
        if (owned.desktopStart) throw new Error(`Desktop stream is already ${owned.desktopStart}`)
        owned.desktopStart = "starting"
        const peer = await owned.peer
        const assertLive = () => {
          if (this.#sessions.get(sessionId) !== owned || this.#closing) throw new Error("Desktop session is closed")
        }
        try {
          assertLive()
          await peer.startDesktop({ displayId, fps, bitrateBps, ...(control === undefined ? {} : { control }) })
          assertLive()
          if (control) await owned.input!.enable()
          assertLive()
          owned.desktopStart = "started"
        } catch (error) {
          const failure = peer.takeMediaFailure?.()
          const startupError = failure?.reason === "encoder" ? encoderFailure(failure.message) : error
          try { await this.#closeSession(sessionId) }
          catch (cleanup) {
            throw desktopStartupCleanupFailure(startupError, cleanup)
          }
          throw startupError
        }
        return null
      }
      case "close":
        await this.#closeSession(request.params.sessionId)
        return null
    }
  }

  async #session(sessionId: string): Promise<NativePeer> {
    const owned = this.#sessions.get(sessionId)
    if (!owned) throw new Error("Unknown desktop session on this connection")
    return owned.peer
  }

  async #events(sessionId: string, owned: OwnedPeer, peer: NativePeer): Promise<void> {
    try {
      for (;;) {
        const event = await peer.nextEvent()
        if (this.#sessions.get(sessionId) !== owned || this.#socket.destroyed) return
        if (!event) {
          await this.#closeSession(sessionId)
          return
        }
        await owned.input?.receive(event)
        if (owned.terminal && event.label === TERMINAL_CHANNEL) {
          if (event.kind === "data" && event.data) {
            void owned.terminal.receive(event.data, event.isString === true).catch(error => {
              if (this.#sessions.get(sessionId) !== owned) return
              this.#send({ event: { sessionId, kind: "error", error: message(error) } })
              void this.#closeSession(sessionId).catch(cleanup => console.error("Terminal peer cleanup failed", cleanup))
            })
          }
          if (event.kind === "dataChannelClosed") owned.terminal.close()
        }
        if (owned.agent && event.label === AGENT_CHANNEL) {
          if (event.kind === "data" && event.data) owned.agent.receive(event.data, event.isString === true)
          if (event.kind === "dataChannelClosed") owned.agent.close()
        }
        let outgoing: DesktopEvent | undefined
        if (event.kind === "iceCandidate" && event.candidate) outgoing = { sessionId, kind: "iceCandidate", candidate: event.candidate }
        if (event.kind === "stateChanged" && event.state) outgoing = { sessionId, kind: "stateChanged", state: event.state }
        if (event.kind === "error") outgoing = desktopErrorEvent(sessionId, event.error ?? "Desktop stream failed", event.reason)
        if (outgoing) this.#send({ event: outgoing })
        if (event.kind === "error" || event.state === "failed" || event.state === "closed" || (event.kind === "dataChannelClosed" && event.label === DESKTOP_INPUT_CHANNEL)) {
          await this.#closeSession(sessionId)
          return
        }
      }
    } catch (error) {
      if (this.#sessions.get(sessionId) === owned) {
        this.#send({ event: { sessionId, kind: "error", error: message(error) } })
        await this.#closeSession(sessionId).catch(cleanup => console.error("Desktop peer cleanup failed", cleanup))
      }
    }
  }

  async #closeSession(sessionId: string): Promise<void> {
    const closing = this.#closingSessions.get(sessionId)
    if (closing) return closing
    const owned = this.#sessions.get(sessionId)
    if (!owned) return
    this.#sessions.delete(sessionId)
    owned.terminal?.close()
    owned.agent?.close()
    owned.input?.close()
    const pending = this.#peers.close(owned.nativeId)
    this.#closingSessions.set(sessionId, pending)
    try { await pending }
    finally { this.#closingSessions.delete(sessionId) }
  }

  close(): Promise<void> {
    this.#socket.destroy()
    this.#unsubscribe()
    this.#dialed.clear()
    this.#closeLocalDeliveries()
    this.#closing ??= Promise.allSettled([
      ...[...new Set([...this.#sessions.keys(), ...this.#closingSessions.keys()])].map(id => this.#closeSession(id)),
      ...[...this.#localPeers].map(([id, central]) => central.closeLocal(id, this)),
    ]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Failed to close desktop sessions")
    })
    return this.#closing
  }
}

async function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(endpoint)
    const finish = (live: boolean) => { socket.destroy(); resolve(live) }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(1_000, () => finish(true))
  })
}

async function publishDiscovery(directory: string, discovery: DaemonDiscovery): Promise<void> {
  const path = daemonDiscoveryPath(directory)
  try {
    await writeFile(path, JSON.stringify(discovery), { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const previous = await readDaemonDiscovery(directory)
    if (await endpointIsLive(previous.endpoint)) throw new Error("A local DeskFleet daemon is already running")
    // Only replace the stale record we inspected; publication itself remains exclusive.
    const current = await readDaemonDiscovery(directory)
    if (current.token !== previous.token) throw new Error("Local daemon discovery changed during startup; retry")
    await rm(path)
    await writeFile(path, JSON.stringify(discovery), { flag: "wx", mode: 0o600 })
  }
}

export async function startControlServer(peers: ControlPeers, directory: string, capabilities: Capabilities = desktopCapabilities, terminals?: TerminalSessions, onShutdownRequested?: () => void, permissions = new DesktopPermissions(), agentProvider?: AgentProvider, options: { agentQuotas?: AgentQuotaAuthority; allowLocalControlForTests?: boolean; openCatalog?: Parameters<DaemonCatalog["init"]>[0] } = {}) {
  const machine = new MachineRuntime(directory, { peers, capabilities, agentProvider, terminals, ...options })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)
  const temporary = await mkdtemp(join(tmpdir(), "df-ipc-"))
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\deskfleet-${randomUUID()}` : join(temporary, "c.sock")
  const discovery: DaemonDiscovery = { endpoint, token: randomBytes(32).toString("hex") }
  const connections = new Set<ControlConnection>()
  const running = new Set<Promise<void>>()
  let stopping: Promise<void> | undefined
  let ready!: () => void
  let failed!: (error: unknown) => void
  const initialized = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  void initialized.catch(() => {})
  const server = createServer(socket => {
    if (stopping) { socket.destroy(); return }
    let connection: ControlConnection | undefined
    const operation = initialized.then(() => {
      if (stopping || socket.destroyed) { socket.destroy(); return }
      const current = machine.current
      connection = new ControlConnection(socket, discovery.token, peers, capabilities, current.terminals, current.catalog, permissions,
        () => machine.current.agents, current.providers, current.setup, () => machine.current.central, () => machine.prepareEnrollment(),
        options.allowLocalControlForTests === true, onShutdownRequested)
      connections.add(connection)
      return connection.run()
    }).catch(error => {
      if (published) console.error("Local desktop connection failed", error)
      socket.destroy()
      return connection?.close().catch(cleanup => console.error("Local connection cleanup failed", cleanup))
    }).finally(() => { if (connection) connections.delete(connection); running.delete(operation) })
    running.add(operation)
  })
  let published = false
  let closing: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    // Keep discovery bound while providers settle accepted RPCs and persist their
    // final state. Existing host connections are closed only on host shutdown.
    const results = await Promise.allSettled([machine.stop(), ...[...connections].map(connection => connection.close()), ...running])
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to stop local daemon connections")
  })()
  const close = () => closing ??= (async () => {
    try { await stop() }
    finally {
      try { await machine.close() }
      finally {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        // Discovery remains owned until all daemon resources have finished closing.
        if (published) {
          const current = await readFile(daemonDiscoveryPath(directory), "utf8").catch(() => "")
          if (current === JSON.stringify(discovery)) await rm(daemonDiscoveryPath(directory), { force: true })
        }
        await rm(temporary, { recursive: true, force: true })
      }
    }
  })()
  try {
    server.listen(endpoint)
    await once(server, "listening")
    if (process.platform !== "win32") await chmod(endpoint, 0o600)
    await publishDiscovery(directory, discovery)
    published = true
    // Selection and recovery happen after discovery ownership, so a second
    // startup cannot open a retired directory or rewrite live terminal metadata.
    await machine.init()
    ready()
    return { stop, close, get central() { return machine.current.central }, get terminals() { return machine.current.terminals } }
  } catch (error) {
    failed(error)
    await close()
    throw error
  }
}
