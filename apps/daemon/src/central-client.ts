import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type { AgentActor } from "./agent-protocol.ts"
import { AuthorizedPeers } from "./authorized-peers.ts"
import { centralUrl, type CentralStatus, type MachineCredentials, type MachineEnrollment, type PeerOffer, type ServerMessage } from "./central-protocol.ts"
import { CentralSync } from "./central-sync.ts"
import type { ControlPeers } from "./control-server.ts"
import type { IceCandidate } from "./control-protocol.ts"
import type { MachineOperations } from "./machine-operations.ts"

/** Outbound machine identity/control link. A lost socket never owns peer cleanup. */
export class CentralClient {
  readonly #path: string
  readonly #operations: MachineOperations
  readonly #peers: AuthorizedPeers
  readonly #sync: CentralSync
  #credentials: MachineCredentials | undefined
  #socket: WebSocket | undefined
  #connected = false
  #closed = false
  #retry: ReturnType<typeof setTimeout> | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #lastReceived = 0
  #requests = new Set<Promise<void>>()
  #enrolling = false

  constructor(directory: string, operations: MachineOperations, peers: ControlPeers) {
    this.#path = join(directory, "central.json")
    this.#operations = operations
    this.#peers = new AuthorizedPeers({
      peers, agents: operations.agents, terminals: operations.terminals,
      identity: operations.agents.journal.identity,
      signal: (peerId, event) => this.#send({ type: "peerEvent", peerId, event }),
    })
    this.#sync = new CentralSync(operations.agents, operations.catalog, operations.providers, (path, body) => this.#http(path, body))
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
      configured: !!credentials, connected: this.#connected,
      ...(credentials ? { serverUrl: credentials.serverUrl, machineId: credentials.machineId, teamId: credentials.teamId } : {}),
      identity: this.#operations.agents.journal.identity, machineName: hostname(),
    }
  }

  async enroll(value: MachineEnrollment): Promise<CentralStatus> {
    if (this.#closed || this.#enrolling) throw new Error("Machine enrollment is unavailable")
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
      const temporary = `${this.#path}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 })
        if (process.platform !== "win32") await chmod(temporary, 0o600)
        await rename(temporary, this.#path)
      } finally { await rm(temporary, { force: true }) }
      this.#credentials = credentials
      this.#peers.bind(credentials)
      this.#connect()
      return this.status()
    } finally { this.#enrolling = false }
  }

  async #http(path: string, body: unknown): Promise<unknown> {
    const credentials = this.#credentials
    if (!credentials || this.#closed) throw new Error("Machine is not connected to a team")
    const response = await fetch(`${credentials.serverUrl}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) await this.#revoked()
      throw new Error(`Central sync failed (${response.status})`)
    }
    return response.json()
  }

  #connect(): void {
    if (this.#closed || !this.#credentials || this.#socket) return
    const url = new URL("/api/daemon/ws", this.#credentials.serverUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url)
    this.#socket = socket
    this.#lastReceived = Date.now()
    socket.addEventListener("open", () => this.#send({ type: "authenticate", token: this.#credentials!.token }))
    socket.addEventListener("message", event => {
      if (this.#socket !== socket) return
      this.#lastReceived = Date.now()
      const pending = this.#message(event.data).catch(error => {
        console.error("Central control message failed", error instanceof Error ? error.message : String(error))
        socket.close(1002, "Invalid control message")
      }).finally(() => this.#requests.delete(pending))
      this.#requests.add(pending)
    })
    socket.addEventListener("error", () => { /* close schedules reconnection */ })
    socket.addEventListener("close", event => {
      if (this.#socket !== socket) return
      this.#socket = undefined; this.#connected = false; this.#sync.disable(); clearInterval(this.#heartbeat)
      if (event.code === 4401 || event.code === 4403) {
        void this.#revoked().catch(error => console.error("Revoked machine cleanup failed", error))
      } else if (!this.#closed) {
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
    if (typeof raw !== "string") throw new Error("Expected JSON control messages")
    const message = JSON.parse(raw) as ServerMessage
    if (message.type === "ready") {
      if (message.machineId !== this.#credentials?.machineId || message.teamId !== this.#credentials?.teamId) throw new Error("Control identity mismatch")
      this.#connected = true; this.#sync.enable(); return
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
      this.#sync.changed()
    } catch (error) {
      this.#send({ type: "response", id: message.id, error: { code: "operation_failed", message: error instanceof Error ? error.message : String(error) } })
    }
  }

  async #request(method: string, value: unknown, actor?: AgentActor): Promise<unknown> {
    const params = value as Record<string, unknown>
    switch (method) {
      case "peer.offer": return this.#peers.offer(value as PeerOffer)
      case "peer.candidate": await this.#peers.candidate(params.peerId as string, params.candidate as IceCandidate); return null
      case "peer.close": await this.#peers.close(params.peerId as string); return null
      case "peer.start": await this.#peers.start(params.peerId as string, {
        displayId: params.displayId as number, fps: params.fps as number | undefined, bitrateBps: params.bitrateBps as number | undefined,
      }); return null
      default: return this.#operations.handle(method, value, actor)
    }
  }

  async #revoked(): Promise<void> {
    this.#sync.disable(); this.#connected = false
    clearTimeout(this.#retry); clearInterval(this.#heartbeat)
    const socket = this.#socket; this.#socket = undefined; socket?.close()
    // Keep revoked registration on disk so a restart cannot silently re-enroll.
    await this.#peers.closeAll()
  }

  async stop(): Promise<void> {
    this.#closed = true; this.#connected = false
    clearTimeout(this.#retry); clearInterval(this.#heartbeat)
    const socket = this.#socket; this.#socket = undefined; socket?.close()
    await this.#sync.close()
    await this.#peers.closeAll()
    await Promise.allSettled([...this.#requests])
  }
}
