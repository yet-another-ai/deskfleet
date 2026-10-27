import type { AgentSignalingApi } from "../../../client/src/agent.ts"
import type { IceCandidate } from "../../../client/src/desktop-media.ts"
import { AGENT_CHANNEL, AGENT_CHUNK_BYTES, AGENT_MESSAGE_BYTES } from "../../../../apps/daemon/src/agent-protocol.ts"
import { AgentMessageDecoder } from "./agent-stream.ts"

export type AgentConnectionState = "idle" | "connecting" | "connected" | "error"
export type AgentNotification = { method: string; params: unknown }
type RpcId = number | string
interface RpcRequest extends AgentNotification { id: RpcId }
interface PendingRequest {
  resolve(result: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}
interface PeerSession {
  id: string
  peer: RTCPeerConnection
  channel: RTCDataChannel
  unsubscribe(): void
  timeout: ReturnType<typeof setTimeout>
  resolve(): void
  reject(error: Error): void
  offered: boolean
  remoteReady: boolean
  localCandidates: IceCandidate[]
  remoteCandidates: IceCandidate[]
  localSending: Promise<void>
  remoteAdding: Promise<void>
  sending: Promise<void>
  queuedBytes: number
  decoder: AgentMessageDecoder
}
const errorOf = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** One ACP facade peer multiplexes Sessions. Closing a viewer never stops their providers. */
export class AgentClient {
  readonly #api: AgentSignalingApi
  readonly #state: (state: AgentConnectionState, error?: string) => void
  readonly #notification: (notification: AgentNotification) => void
  readonly #request?: (request: RpcRequest) => Promise<unknown>
  readonly #pending = new Map<number, PendingRequest>()
  #current: PeerSession | null = null
  #connecting: Promise<void> | null = null
  #generation = 0
  #nextId = 0

  constructor(
    api: AgentSignalingApi,
    state: (state: AgentConnectionState, error?: string) => void,
    notification: (notification: AgentNotification) => void,
    request?: (request: RpcRequest) => Promise<unknown>,
  ) {
    this.#api = api
    this.#state = state
    this.#notification = notification
    this.#request = request
  }

  connect(): Promise<void> {
    if (this.#connecting) return this.#connecting
    this.#state("connecting")
    const generation = ++this.#generation
    const id = crypto.randomUUID()
    const connecting = new Promise<void>((resolve, reject) => {
      const begin = (iceServers: RTCIceServer[]) => {
      if (generation !== this.#generation) {
        void this.#api.close(id).catch(() => {})
        reject(new Error("Connection was cancelled")); return
      }
      try {
        const peer = new RTCPeerConnection({ iceServers })
        const channel = peer.createDataChannel(AGENT_CHANNEL, { ordered: true })
        channel.binaryType = "arraybuffer"
        channel.bufferedAmountLowThreshold = 64 * 1024
        const session: PeerSession = {
          id, peer, channel, unsubscribe: () => {}, resolve, reject,
          timeout: setTimeout(() => this.#fail(session, new Error(this.#api.connectionFailure?.(session.id) ?? "Agent connection timed out")), 20_000),
          offered: false, remoteReady: false, localCandidates: [], remoteCandidates: [],
          localSending: Promise.resolve(), remoteAdding: Promise.resolve(), sending: Promise.resolve(), queuedBytes: 0,
          decoder: new AgentMessageDecoder(message => this.#message(session, message)),
        }
        this.#current = session
        session.unsubscribe = this.#api.onEvent(event => {
          if (event.sessionId !== session.id || this.#current !== session) return
          if (event.kind === "iceCandidate") {
            session.remoteCandidates.push(event.candidate)
            this.#addCandidates(session)
          } else if (event.kind === "error") this.#fail(session, new Error(event.error))
          else if (["failed", "closed", "disconnected"].includes(event.state.toLowerCase())) this.#fail(session, new Error(this.#api.connectionFailure?.(session.id) ?? "Agent connection closed"))
        })
        peer.onicecandidate = ({ candidate }) => {
          if (!candidate || this.#current !== session) return
          const value = candidate.toJSON()
          session.localCandidates.push({
            candidate: value.candidate ?? "",
            ...(value.sdpMid != null ? { sdpMid: value.sdpMid } : {}),
            ...(value.sdpMLineIndex != null ? { sdpMlineIndex: value.sdpMLineIndex } : {}),
            ...(value.usernameFragment != null ? { usernameFragment: value.usernameFragment } : {}),
          })
          this.#sendCandidates(session)
        }
        peer.onconnectionstatechange = () => {
          if (["failed", "closed", "disconnected"].includes(peer.connectionState)) this.#fail(session, new Error(this.#api.connectionFailure?.(session.id) ?? "Agent connection closed"))
        }
        channel.onopen = () => this.#ready(session)
        channel.onclose = () => this.#fail(session, new Error(this.#api.connectionFailure?.(session.id) ?? "Agent connection closed"))
        channel.onerror = () => this.#fail(session, new Error("Agent DataChannel failed"))
        channel.onmessage = ({ data }) => {
          if (this.#current !== session) return
          try {
            if (!(data instanceof ArrayBuffer)) throw new Error("Expected ACP byte frames")
            if (data.byteLength > AGENT_CHUNK_BYTES) throw new Error("ACP frame exceeds the 16 KiB limit")
            session.decoder.write(new Uint8Array(data))
          } catch (error) { this.#fail(session, errorOf(error)) }
        }
        void this.#negotiate(session).catch(error => this.#fail(session, errorOf(error)))
      } catch (error) { this.#state("error", errorOf(error).message); reject(errorOf(error)) }
      }
      if (this.#api.prepare) void this.#api.prepare(id).then(begin, error => { this.#state("error", errorOf(error).message); reject(errorOf(error)) })
      else begin([])
    })
    this.#connecting = connecting
    void connecting.catch(() => { if (this.#connecting === connecting) this.#connecting = null })
    return connecting
  }

  async #negotiate(session: PeerSession): Promise<void> {
    const offer = await session.peer.createOffer()
    if (this.#current !== session) return
    await session.peer.setLocalDescription(offer)
    if (this.#current !== session) return
    const answer = await this.#api.offer({ sessionId: session.id, sdp: offer.sdp! })
    if (this.#current !== session) { await this.#api.close(session.id); return }
    session.offered = true
    this.#sendCandidates(session)
    await session.peer.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    if (this.#current !== session) return
    session.remoteReady = true
    this.#addCandidates(session)
    this.#ready(session)
  }
  #ready(session: PeerSession): void {
    if (this.#current !== session || !session.remoteReady || session.channel.readyState !== "open") return
    clearTimeout(session.timeout)
    this.#state("connected")
    session.resolve()
  }
  #sendCandidates(session: PeerSession): void {
    if (this.#current !== session || !session.offered) return
    const candidates = session.localCandidates.splice(0)
    session.localSending = session.localSending.then(async () => {
      for (const candidate of candidates) {
        if (this.#current !== session) return
        await this.#api.candidate(session.id, candidate)
      }
    }).catch(error => this.#fail(session, errorOf(error)))
  }
  #addCandidates(session: PeerSession): void {
    if (this.#current !== session || !session.remoteReady) return
    const candidates = session.remoteCandidates.splice(0)
    session.remoteAdding = session.remoteAdding.then(async () => {
      for (const candidate of candidates) {
        if (this.#current !== session) return
        await session.peer.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMlineIndex, usernameFragment: candidate.usernameFragment })
      }
    }).catch(error => this.#fail(session, errorOf(error)))
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const connection = this.connect()
    await connection
    if (this.#connecting !== connection) throw new Error("Agent connection closed")
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#nextId
      const timeout = setTimeout(() => {
        if (this.#current) this.#fail(this.#current, new Error(`Agent ${method} response timed out; reconnect to check its result`))
      }, 60_000)
      this.#pending.set(id, { resolve: result => resolve(result as T), reject, timeout })
      void this.#send({ jsonrpc: "2.0", id, method, params }).catch(error => {
        const pending = this.#pending.get(id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.#pending.delete(id)
        pending.reject(errorOf(error))
      })
    })
  }

  #send(message: unknown): Promise<void> {
    const session = this.#current
    if (!session || session.channel.readyState !== "open") return Promise.reject(new Error("Agent connection closed"))
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n")
    if (bytes.length - 1 > AGENT_MESSAGE_BYTES) return Promise.reject(new Error("Agent message exceeds the 32 MiB limit"))
    if (session.queuedBytes + bytes.length > AGENT_MESSAGE_BYTES + 1) return Promise.reject(new Error("Agent send queue is full"))
    session.queuedBytes += bytes.length
    const sending = session.sending.then(async () => {
      const negotiated = session.peer.sctp?.maxMessageSize
      const chunkSize = negotiated && Number.isFinite(negotiated) ? Math.min(AGENT_CHUNK_BYTES, negotiated) : AGENT_CHUNK_BYTES
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        await this.#capacity(session)
        if (this.#current !== session || session.channel.readyState !== "open") throw new Error("Agent connection closed")
        session.channel.send(bytes.subarray(offset, offset + chunkSize))
      }
    }).finally(() => { session.queuedBytes -= bytes.length })
    session.sending = sending.catch(error => this.#fail(session, errorOf(error)))
    return sending
  }

  #capacity(session: PeerSession): Promise<void> {
    const channel = session.channel
    if (channel.bufferedAmount <= 256 * 1024) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        channel.removeEventListener("bufferedamountlow", ready)
        channel.removeEventListener("close", closed)
        channel.removeEventListener("error", closed)
      }
      const ready = () => { cleanup(); resolve() }
      const closed = () => { cleanup(); reject(new Error("Agent connection closed")) }
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Agent send buffer stalled")) }, 30_000)
      channel.addEventListener("bufferedamountlow", ready, { once: true })
      channel.addEventListener("close", closed, { once: true })
      channel.addEventListener("error", closed, { once: true })
      if (channel.readyState !== "open" || this.#current !== session) closed()
      else if (channel.bufferedAmount <= 64 * 1024) ready()
    })
  }

  #message(session: PeerSession, value: unknown): void {
    if (!object(value) || value.jsonrpc !== "2.0") throw new Error("Invalid agent JSON-RPC message")
    if (typeof value.method === "string") {
      if (typeof value.id === "number" || typeof value.id === "string") {
        const id = value.id
        const handleRequest = this.#request
        if (!handleRequest) {
          void this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client method is not supported" } }).catch(error => this.#fail(session, errorOf(error)))
          return
        }
        const request = { id, method: value.method, params: value.params }
        void Promise.resolve().then(() => handleRequest(request)).then(result => {
          if (this.#current === session) return this.#send({ jsonrpc: "2.0", id, result })
        }, error => {
          if (this.#current === session) return this.#send({ jsonrpc: "2.0", id, error: { code: -32000, message: errorOf(error).message } })
        }).catch(error => this.#fail(session, errorOf(error)))
      } else this.#notification({ method: value.method, params: value.params })
      return
    }
    if (typeof value.id !== "number") throw new Error("Invalid agent response ID")
    const pending = this.#pending.get(value.id)
    if (!pending) return
    this.#pending.delete(value.id)
    clearTimeout(pending.timeout)
    if (object(value.error)) pending.reject(new Error(typeof value.error.message === "string" ? value.error.message : "Agent operation failed"))
    else if ("result" in value) pending.resolve(value.result)
    else pending.reject(new Error("Invalid agent response"))
  }

  #release(session: PeerSession, error: Error): void {
    if (this.#current !== session) return
    this.#current = null
    this.#connecting = null
    clearTimeout(session.timeout)
    session.unsubscribe()
    session.peer.onicecandidate = null
    session.peer.onconnectionstatechange = null
    session.channel.onopen = session.channel.onclose = session.channel.onerror = session.channel.onmessage = null
    session.channel.close()
    session.peer.close()
    session.reject(error)
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error) }
    this.#pending.clear()
    void this.#api.close(session.id).catch(() => {})
  }
  #fail(session: PeerSession, error: Error): void {
    if (this.#current !== session) return
    this.#release(session, error)
    this.#state("error", error.message)
  }
  close(): void {
    ++this.#generation
    this.#connecting = null
    if (this.#current) this.#release(this.#current, new Error("Agent connection closed"))
    this.#state("idle")
  }
}
