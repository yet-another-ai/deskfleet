import type { CentralApi, LocalPeerGrant } from "@deskfleet/client/central"
import { LOCAL_CHANNEL_BUFFER_BYTES, LOCAL_CHANNEL_BUFFER_MESSAGES, LOCAL_CHANNEL_MESSAGE_BYTES, type LocalChannelEvent, type LocalChannelOpen } from "@deskfleet/client/local-channels"
import type { ControlMethods, DaemonEvent } from "../../../daemon/src/control-protocol.ts"

export type LocalChannelAuthority = Pick<CentralApi, "status" | "closePeer"> & {
  createLocalPeer(teamId: string, machineId: string, purpose: "agent" | "terminal"): Promise<LocalPeerGrant>
}
export interface LocalChannelDaemon {
  readonly closed: boolean
  call<M extends keyof ControlMethods>(method: M, params: ControlMethods[M]["params"]): Promise<ControlMethods[M]["result"]>
  close(): void
}
export type LocalChannelDelivery = LocalChannelEvent & { sequence?: number }
export type ConnectLocalDaemon = (event: (event: DaemonEvent) => void, disconnected: (error: Error) => void) => Promise<LocalChannelDaemon>

interface Connection {
  id: string
  client?: LocalChannelDaemon
  peerId?: string
  ready: boolean
  bytes: number
  messages: number
  sending: Promise<void>
}

/** A renderer document owns its local connections; authority and claim tokens stay in main. */
export class WindowLocalChannels {
  readonly #central: LocalChannelAuthority
  readonly #connect: ConnectLocalDaemon
  readonly #emit: (event: LocalChannelDelivery) => void
  readonly #connections = new Map<string, Connection>()
  readonly #closing = new Set<Promise<void>>()
  #disposed = false

  constructor(central: LocalChannelAuthority, connect: ConnectLocalDaemon, emit: (event: LocalChannelDelivery) => void) {
    this.#central = central
    this.#connect = connect
    this.#emit = emit
  }

  async open(request: LocalChannelOpen): Promise<void> {
    if (this.#disposed) throw new Error("Local channel window has closed")
    if (this.#connections.has(request.connectionId)) throw new Error("Local channel already exists")
    const connection: Connection = { id: request.connectionId, ready: false, bytes: 0, messages: 0, sending: Promise.resolve() }
    this.#connections.set(connection.id, connection)
    try {
      const client = await this.#connect(event => this.#event(connection, event), error => this.#retire(connection, error.message))
      connection.client = client
      if (!this.#current(connection)) { client.close(); throw new Error("Local channel was cancelled") }
      const [account, local] = await Promise.all([this.#central.status(), client.call("centralStatus", {})])
      this.#requireCurrent(connection)
      if (!account.user || !local.configured || local.revoked || local.serverUrl !== account.serverUrl
        || local.machineId !== request.machineId || local.teamId !== request.teamId) {
        throw new Error("Direct channels require this client's registered local machine")
      }
      const grant = await this.#central.createLocalPeer(request.teamId, request.machineId, request.purpose)
      connection.peerId = grant.peerId
      if (!this.#current(connection)) {
        await this.#central.closePeer(grant.peerId).catch(() => {})
        throw new Error("Local channel was cancelled")
      }
      const auth = grant.authorization
      if (auth.transport !== "local" || auth.peerId !== grant.peerId || auth.teamId !== local.teamId
        || auth.targetMachine.id !== local.machineId || auth.targetMachine.originId !== local.identity.originId
        || auth.targetMachine.localMachineId !== local.identity.machineId || auth.actor.userId !== account.user.id
        || auth.purpose !== request.purpose) throw new Error("Local channel authorization does not match this machine and account")
      await client.call("localOpen", { peerId: grant.peerId, token: grant.token })
      this.#requireCurrent(connection)
      connection.ready = true
    } catch (error) {
      this.#retire(connection, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  send(id: string, data: string | Uint8Array): Promise<void> {
    const connection = this.#owned(id)
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
    if (bytes > LOCAL_CHANNEL_MESSAGE_BYTES) throw new Error("Local channel message is too large")
    if (connection.bytes + bytes > LOCAL_CHANNEL_BUFFER_BYTES || connection.messages >= LOCAL_CHANNEL_BUFFER_MESSAGES) throw new Error("Local channel send buffer is full")
    const encoded = typeof data === "string" ? data : Buffer.from(data).toString("base64")
    connection.bytes += bytes
    connection.messages += 1
    const sending = connection.sending.then(async () => {
      this.#requireCurrent(connection)
      await connection.client!.call("localSend", { peerId: connection.peerId!, data: encoded, isString: typeof data === "string" })
    }).catch(error => {
      this.#retire(connection, error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => { connection.bytes -= bytes; connection.messages -= 1 })
    connection.sending = sending.catch(() => {})
    return sending
  }

  async acknowledge(id: string, sequence: number): Promise<void> {
    const connection = this.#owned(id)
    await connection.client!.call("localAck", { peerId: connection.peerId!, sequence })
  }

  async close(id: string): Promise<void> {
    const connection = this.#connections.get(id)
    if (connection) this.#retire(connection)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const connection of this.#connections.values()) this.#retire(connection, "Local channel window has closed")
    await Promise.all(this.#closing)
  }

  #current(connection: Connection): boolean {
    return !this.#disposed && this.#connections.get(connection.id) === connection
  }
  #requireCurrent(connection: Connection): void {
    if (!this.#current(connection)) throw new Error("Local channel was cancelled")
  }
  #owned(id: string): Connection {
    const connection = this.#connections.get(id)
    if (!connection?.ready || !connection.client || connection.client.closed || !this.#current(connection)) {
      throw new Error("Local channel is not open in this window")
    }
    return connection
  }

  #event(connection: Connection, event: DaemonEvent): void {
    if (!this.#current(connection) || !("peerId" in event) || event.peerId !== connection.peerId) return
    if (event.kind === "localChannelClosed") this.#retire(connection, event.error)
    else if (event.kind === "localChannelMessage") {
      this.#emit({
        connectionId: connection.id, kind: "message", sequence: event.sequence,
        data: event.isString ? event.data : new Uint8Array(Buffer.from(event.data, "base64")),
      })
    }
  }

  #retire(connection: Connection, error?: string): void {
    if (this.#connections.get(connection.id) !== connection) return
    this.#connections.delete(connection.id)
    connection.ready = false
    // A dedicated socket makes cleanup immediate, including setup still awaiting a response.
    connection.client?.close()
    this.#emit({ connectionId: connection.id, kind: "closed", ...(error ? { error } : {}) })
    if (connection.peerId) {
      const closing = this.#central.closePeer(connection.peerId).catch(() => {}).finally(() => this.#closing.delete(closing))
      this.#closing.add(closing)
    }
  }
}
