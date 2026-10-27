import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type { AgentActor } from "./agent-protocol.ts"
import { AuthorizedPeers } from "./authorized-peers.ts"
import { centralUrl, type CentralStatus, type MachineCredentials, type MachineEnrollment, type PeerOffer, type ServerMessage } from "./central-protocol.ts"
import { CentralSync } from "./central-sync.ts"
import type { ControlPeers } from "./control-server.ts"
import { isEncoderFailure, type IceCandidate } from "./control-protocol.ts"
import { validateRelayedDesktopStart } from "./control-request.ts"
import type { MachineOperations } from "./machine-operations.ts"

/** Outbound machine identity/control link. A lost socket never owns peer cleanup. */
export class CentralClient {
  readonly #path: string
  readonly #operations: MachineOperations
  readonly #peers: AuthorizedPeers
  readonly #sync: CentralSync
  readonly #unsubscribeTerminals: () => void
  #credentials: MachineCredentials | undefined
  #socket: WebSocket | undefined
  #connected = false
  #closed = false
  #stopping = false
  #stop: Promise<void> | undefined
  #close: Promise<void> | undefined
  readonly #httpClosing = new AbortController()
  readonly #shutdownTimeoutMs: number
  #retry: ReturnType<typeof setTimeout> | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #lastReceived = 0
  #requests = new Set<Promise<void>>()
  #enrolling = false
  #revocation: Promise<void> | undefined

  constructor(directory: string, operations: MachineOperations, peers: ControlPeers, shutdownTimeoutMs = 5_000) {
    this.#shutdownTimeoutMs = shutdownTimeoutMs
    this.#path = join(directory, "central.json")
    this.#operations = operations
    this.#peers = new AuthorizedPeers({
      peers, agents: operations.agents, terminals: operations.terminals,
      identity: operations.agents.journal.identity,
      signal: (peerId, event) => this.#send({ type: "peerEvent", peerId, event }),
    })
    this.#sync = new CentralSync(operations.agents, operations.catalog, operations.providers, (path, body) => this.#http(path, body))
    this.#unsubscribeTerminals = operations.terminals.onChange(() => this.#sync.changed())
  }

  async init(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.#path, "utf8")) as MachineCredentials
      this.#credentials = { ...saved, serverUrl: centralUrl(saved.serverUrl) }
      this.#peers.bind(this.#credentials)
      this.#connect()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  status(): CentralStatus {
    const credentials = this.#credentials
    return {
      configured: !!credentials, connected: this.#connected, revoked: credentials?.revoked === true,
      ...(credentials ? { serverUrl: credentials.serverUrl, machineId: credentials.machineId, teamId: credentials.teamId } : {}),
      identity: this.#operations.agents.journal.identity, machineName: hostname(),
    }
  }

  desktopCapabilitiesChanged(): void { this.#sync.changed() }

  /** Schedules and session tools retain user intent, never a reusable user login token. */
  async authorizeDelegation(actor: AgentActor): Promise<AgentActor> {
    const credentials = this.#credentials
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user delegation is required")
    if (!credentials || credentials.revoked || this.#stopping || this.#closed) throw new Error("Machine delegation is unavailable")
    const response = await fetch(`${credentials.serverUrl}/api/daemon/authorize-delegation`, {
      method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: actor.userId }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), this.#httpClosing.signal]),
    })
    // A removed user is forbidden without revoking this otherwise valid machine.
    if (response.status === 401) await this.#revoked()
    if (!response.ok) throw new Error(`User delegation is no longer authorized (${response.status})`)
    const result = await response.json() as { authorized?: boolean }
    if (result.authorized !== true) throw new Error("Backend did not authorize this user delegation")
    return structuredClone(actor)
  }

  /** Machine credentials authorize fresh quota decisions independently of peer lifetime. */
  async quotaRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const credentials = this.#credentials
    if (!credentials || credentials.revoked || this.#stopping || this.#closed) throw new Error("Team allowance is unavailable")
    const response = await fetch(`${credentials.serverUrl}${path}`, {
      method, headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), this.#httpClosing.signal]),
    })
    if (response.status === 401) await this.#revoked()
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string; error?: { message?: string } | string } | null
      const message = error?.message ?? (typeof error?.error === "string" ? error.error : error?.error?.message)
      throw new Error(message || `Team allowance request failed (${response.status})`)
    }
    return response.json()
  }

  async enroll(value: MachineEnrollment): Promise<CentralStatus> {
    if (this.#stopping || this.#closed || this.#enrolling) throw new Error("Machine enrollment is unavailable")
    if (this.#credentials) throw new Error("This daemon already belongs to a team")
    this.#enrolling = true
    try {
      const serverUrl = centralUrl(value.serverUrl)
      const response = await fetch(`${serverUrl}/api/daemon/me`, { headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Machine enrollment verification failed (${response.status})`)
      const verified = await response.json() as {
        serverId: string; machine: { id: string; teamId: string; originId: string; localMachineId: string }
      }
      const identity = this.#operations.agents.journal.identity
      if (!verified.serverId || verified.machine.id !== value.machineId || verified.machine.teamId !== value.teamId ||
        verified.machine.originId !== identity.originId || verified.machine.localMachineId !== identity.machineId) {
        throw new Error("Machine credentials do not match this daemon and selected team")
      }
      const credentials: MachineCredentials = { ...value, serverUrl, serverId: verified.serverId }
      await this.#save(credentials)
      this.#credentials = credentials
      this.#peers.bind(credentials)
      this.#connect()
      return this.status()
    } finally { this.#enrolling = false }
  }

  async #save(credentials: MachineCredentials): Promise<void> {
    const temporary = `${this.#path}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 })
      if (process.platform !== "win32") await chmod(temporary, 0o600)
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
  }

  async #http(path: string, body: unknown): Promise<unknown> {
    const credentials = this.#credentials
    if (!credentials || this.#closed) throw new Error("Machine is not connected to a team")
    const response = await fetch(`${credentials.serverUrl}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30_000), this.#httpClosing.signal]),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) await this.#revoked()
      throw new Error(`Central sync failed (${response.status})`)
    }
    return response.json()
  }

  #connect(): void {
    if (this.#stopping || this.#closed || !this.#credentials || this.#credentials.revoked || this.#socket) return
    const url = new URL("/api/daemon/ws", this.#credentials.serverUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url)
    this.#socket = socket
    this.#lastReceived = Date.now()
    socket.addEventListener("open", () => this.#send({ type: "authenticate", token: this.#credentials!.token }))
    socket.addEventListener("message", event => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return
      this.#lastReceived = Date.now()
      const pending = this.#message(event.data).catch(error => {
        console.error("Central control message failed", error instanceof Error ? error.message : String(error))
        if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return
        // Node and browser WebSockets only allow 1000 or application codes 3000–4999.
        socket.close(4002, "Invalid control message")
      }).finally(() => this.#requests.delete(pending))
      this.#requests.add(pending)
    })
    socket.addEventListener("error", () => { /* close schedules reconnection */ })
    socket.addEventListener("close", event => {
      if (this.#socket !== socket) return
      this.#socket = undefined; this.#connected = false; this.#sync.disable(); clearInterval(this.#heartbeat)
      if (event.code === 4401 || event.code === 4403) {
        void this.#revoked().catch(error => console.error("Revoked machine cleanup failed", error))
      } else if (!this.#stopping && !this.#closed) {
        this.#retry = setTimeout(() => this.#connect(), 2_000); this.#retry.unref()
      }
    })
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastReceived > 60_000) socket.close(4000, "Control link heartbeat timed out")
      else this.#send({ type: "ping" })
    }, 20_000)
    this.#heartbeat.unref()
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message))
  }

  async #message(raw: unknown): Promise<void> {
    if (this.#stopping) return
    if (typeof raw !== "string") throw new Error("Expected JSON control messages")
    const message = JSON.parse(raw) as ServerMessage
    if (message.type === "ready") {
      if (message.machineId !== this.#credentials?.machineId || message.teamId !== this.#credentials?.teamId || message.serverId !== this.#credentials?.serverId) throw new Error("Control identity mismatch")
      this.#connected = true; this.#sync.enable()
      void this.#operations.agents.reconcileAdmissions().catch(error => console.error("Session admission reconciliation failed", error))
      return
    }
    if (message.type === "ping") { this.#send({ type: "pong" }); return }
    if (message.type === "pong") return
    if (!this.#connected) throw new Error("Authenticate the control channel first")
    if (message.type === "peerRevoked") { await this.#peers.close(message.peerId); return }
    if (message.type === "reconcilePeers") { await this.#peers.reconcile(message.peers); return }
    if (message.type !== "request") throw new Error("Unknown control message")
    // Each RPC is independent: a slow Provider operation must not block revocation.
    try {
      const result = await this.#request(message.method, message.params, message.actor)
      this.#send({ type: "response", id: message.id, result })
    } catch (error) {
      this.#send({ type: "response", id: message.id, error: { code: "operation_failed", message: error instanceof Error ? error.message : String(error), ...(isEncoderFailure(error) ? { reason: "encoder" as const } : {}) } })
    }
  }

  async #request(method: string, value: unknown, actor?: AgentActor): Promise<unknown> {
    const params = value as Record<string, unknown>
    switch (method) {
      case "peer.offer": return this.#peers.offer(value as PeerOffer)
      case "peer.candidate": await this.#peers.candidate(params.peerId as string, params.candidate as IceCandidate); return null
      case "peer.close": await this.#peers.close(params.peerId as string); return null
      case "peer.start": await this.#peers.start(params.peerId as string, validateRelayedDesktopStart(params)); return null
      default: return this.#operations.handle(method, value, actor)
    }
  }

  #revoked(): Promise<void> {
    if (this.#revocation) return this.#revocation
    this.#sync.disable(); this.#connected = false
    clearTimeout(this.#retry); clearInterval(this.#heartbeat)
    const socket = this.#socket; this.#socket = undefined; socket?.close()
    const credentials = this.#credentials
    if (credentials) this.#credentials = { ...credentials, revoked: true }
    // Keep the retired identity and its data in place. A new registration must
    // explicitly prepare a different, empty machine directory.
    return this.#revocation = Promise.all([
      this.#peers.closeAll(),
      this.#credentials ? this.#save(this.#credentials) : undefined,
    ]).then(() => {})
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop
    this.#stopping = true; this.#connected = false
    this.#sync.disable()
    clearTimeout(this.#retry); clearInterval(this.#heartbeat)
    const socket = this.#socket; this.#socket = undefined; socket?.close()
    return this.#stop = (async () => {
      await this.#peers.closeAll()
      await Promise.allSettled([...this.#requests])
    })()
  }

  /** Called after Agent/PTY producers and their accepted management RPCs stop. */
  close(): Promise<void> {
    return this.#close ??= (async () => {
      try { await this.stop(); await this.#revocation }
      finally {
        this.#unsubscribeTerminals()
        const deadline = setTimeout(() => this.#httpClosing.abort(new Error("Final history synchronization timed out")), this.#shutdownTimeoutMs)
        try { await this.#sync.close(!!this.#credentials && !this.#credentials.revoked) }
        finally {
          clearTimeout(deadline)
          this.#httpClosing.abort()
          this.#closed = true
        }
      }
    })()
  }
}
