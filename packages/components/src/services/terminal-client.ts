import type { TerminalSignalingApi } from "../../../client/src/terminal.ts"
import type { IceCandidate } from "../../../client/src/desktop-media.ts"
import {
  MAX_TERMINAL_MESSAGE_BYTES,
  TERMINAL_CHANNEL,
  TERMINAL_CHUNK_BYTES,
  type TerminalEvent,
  type TerminalMessage,
  type TerminalMethods,
} from "../../../../apps/daemon/src/terminal-protocol.ts"

export type TerminalConnectionState = "idle" | "connecting" | "connected" | "error"
export type TerminalListener = (event: TerminalEvent, acknowledge: () => void) => void
type TransportSignaling = Pick<TerminalSignalingApi, "offer" | "candidate" | "close" | "onEvent" | "prepare">

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PeerSession {
  id: string
  peer: RTCPeerConnection
  channel: RTCDataChannel
  unsubscribe: () => void
  timeout: ReturnType<typeof setTimeout>
  resolve: () => void
  reject: (error: Error) => void
  offered: boolean
  remoteReady: boolean
  localCandidates: IceCandidate[]
  remoteCandidates: IceCandidate[]
  localSending: Promise<void>
  remoteAdding: Promise<void>
}

interface InputEntry {
  data: Uint8Array
  offset: number
  resolve: () => void
  reject: (error: Error) => void
}

interface InputQueue {
  session: PeerSession
  bytes: number
  entries: InputEntry[]
}

const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))

export function encodeTerminalBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function decodeTerminalBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}

/** A data-only peer. Terminal processes belong to the daemon, independently of this connection. */
export class TerminalClient {
  readonly #api: TransportSignaling
  readonly #state: (state: TerminalConnectionState, error?: string) => void
  readonly #event: (event: TerminalEvent) => void
  readonly #pending = new Map<number, PendingRequest>()
  readonly #listeners = new Map<string, TerminalListener>()
  readonly #inputQueues = new Map<string, InputQueue>()
  #nextId = 0
  #current: PeerSession | null = null
  #connecting: Promise<void> | null = null
  #generation = 0

  constructor(
    api: TransportSignaling,
    state: (state: TerminalConnectionState, error?: string) => void = () => {},
    event: (event: TerminalEvent) => void = () => {},
  ) {
    this.#api = api
    this.#state = state
    this.#event = event
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
        const channel = peer.createDataChannel(TERMINAL_CHANNEL, { ordered: true })
        const session: PeerSession = {
          id, peer, channel, unsubscribe: () => {},
          timeout: setTimeout(() => this.#fail(session, new Error("Terminal connection timed out")), 20_000),
          resolve, reject, offered: false, remoteReady: false,
          localCandidates: [], remoteCandidates: [],
          localSending: Promise.resolve(), remoteAdding: Promise.resolve(),
        }
        this.#current = session
        session.unsubscribe = this.#api.onEvent((event) => {
          if (event.sessionId !== session.id || this.#current !== session) return
          if (event.kind === "iceCandidate") {
            session.remoteCandidates.push(event.candidate)
            this.#addCandidates(session)
          } else if (event.kind === "error") {
            this.#fail(session, new Error(event.error))
          } else if (["failed", "closed", "disconnected"].includes(event.state.toLowerCase())) {
            this.#fail(session, new Error("Terminal connection closed"))
          }
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
          if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
            this.#fail(session, new Error("Terminal connection closed"))
          }
        }
        channel.onopen = () => this.#ready(session)
        channel.onclose = () => this.#fail(session, new Error("Terminal connection closed"))
        channel.onerror = () => this.#fail(session, new Error("Terminal data channel failed"))
        channel.onmessage = ({ data }) => this.#message(session, data)
        void this.#negotiate(session).catch((error: unknown) => this.#fail(session, errorOf(error)))
      } catch (error) {
        this.#state("error", errorOf(error).message)
        reject(errorOf(error))
      }
      }
      if (this.#api.prepare) void this.#api.prepare(id).then(begin, error => { this.#state("error", errorOf(error).message); reject(errorOf(error)) })
      else begin([])
    })
    this.#connecting = connecting
    // A failed connection can be retried explicitly without replaying failed requests.
    void connecting.catch(() => {
      if (this.#connecting === connecting) this.#connecting = null
    })
    return connecting
  }

  async #negotiate(session: PeerSession): Promise<void> {
    const offer = await session.peer.createOffer()
    if (this.#current !== session) return
    await session.peer.setLocalDescription(offer)
    if (this.#current !== session) return
    const answer = await this.#api.offer({ sessionId: session.id, sdp: offer.sdp! })
    if (this.#current !== session) {
      await this.#api.close(session.id)
      return
    }
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
    }).catch((error: unknown) => this.#fail(session, errorOf(error)))
  }

  #addCandidates(session: PeerSession): void {
    if (this.#current !== session || !session.remoteReady) return
    const candidates = session.remoteCandidates.splice(0)
    session.remoteAdding = session.remoteAdding.then(async () => {
      for (const candidate of candidates) {
        if (this.#current !== session) return
        await session.peer.addIceCandidate({
          candidate: candidate.candidate,
          ...(candidate.sdpMid != null ? { sdpMid: candidate.sdpMid } : {}),
          ...(candidate.sdpMlineIndex != null ? { sdpMLineIndex: candidate.sdpMlineIndex } : {}),
          ...(candidate.usernameFragment != null ? { usernameFragment: candidate.usernameFragment } : {}),
        })
      }
    }).catch((error: unknown) => this.#fail(session, errorOf(error)))
  }

  async call<M extends keyof TerminalMethods>(method: M, params: TerminalMethods[M]["params"]): Promise<TerminalMethods[M]["result"]> {
    const connection = this.connect()
    await connection
    if (this.#connecting !== connection) throw new Error("Terminal connection closed")
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId
      const timeout = setTimeout(() => {
        if (this.#current) this.#fail(this.#current, new Error(`Terminal ${method} timed out`))
      }, 15_000)
      this.#pending.set(id, { resolve: (result) => resolve(result as TerminalMethods[M]["result"]), reject, timeout })
      try { this.#send({ id, method, params }) }
      catch (error) {
        clearTimeout(timeout)
        this.#pending.delete(id)
        reject(errorOf(error))
      }
    })
  }

  subscribe(sessionId: string, listener: TerminalListener): () => void {
    this.#listeners.set(sessionId, listener)
    return () => {
      if (this.#listeners.get(sessionId) !== listener) return
      this.#listeners.delete(sessionId)
      // Never reconnect just to detach from a dead peer.
      if (this.#current?.channel.readyState === "open") {
        void this.call("detach", { sessionId }).catch(() => {})
      }
    }
  }

  /** Coalesce keys while a write is in flight; bound paste/input without a round trip per key. */
  input(sessionId: string, data: string): Promise<void> {
    const session = this.#current
    if (!session || session.channel.readyState !== "open") return Promise.reject(new Error("Terminal is disconnected"))
    const bytes = new TextEncoder().encode(data)
    const existing = this.#inputQueues.get(sessionId)
    const queue = existing ?? { session, bytes: 0, entries: [] }
    if (queue.session !== session) return Promise.reject(new Error("Terminal connection closed"))
    if (bytes.byteLength + queue.bytes > 256 * 1024) return Promise.reject(new Error("Terminal input exceeds the 256 KiB pending limit"))
    if (bytes.byteLength === 0) return Promise.resolve()
    queue.bytes += bytes.byteLength
    this.#inputQueues.set(sessionId, queue)
    const result = new Promise<void>((resolve, reject) => {
      queue.entries.push({ data: bytes, offset: 0, resolve, reject })
    })
    if (!existing) void this.#flushInput(sessionId, queue)
    return result
  }

  async #flushInput(sessionId: string, queue: InputQueue): Promise<void> {
    const completed: InputEntry[] = []
    try {
      while (queue.entries.length > 0) {
        if (this.#current !== queue.session) throw new Error("Terminal connection closed")
        const data = new Uint8Array(Math.min(queue.bytes, TERMINAL_CHUNK_BYTES))
        let offset = 0
        while (offset < data.length) {
          const entry = queue.entries[0]!
          const length = Math.min(data.length - offset, entry.data.length - entry.offset)
          data.set(entry.data.subarray(entry.offset, entry.offset + length), offset)
          offset += length
          entry.offset += length
          if (entry.offset === entry.data.length) completed.push(queue.entries.shift()!)
        }
        await this.call("input", { sessionId, data: encodeTerminalBytes(data) })
        queue.bytes -= data.length
        for (const entry of completed.splice(0)) entry.resolve()
      }
    } catch (error) {
      for (const entry of [...completed, ...queue.entries]) entry.reject(errorOf(error))
    } finally {
      if (this.#inputQueues.get(sessionId) === queue) this.#inputQueues.delete(sessionId)
    }
  }

  #send(message: unknown): void {
    const session = this.#current
    if (!session || session.channel.readyState !== "open") throw new Error("Terminal is disconnected")
    if (session.channel.bufferedAmount > 1024 * 1024) throw new Error("Terminal send buffer is full")
    session.channel.send(JSON.stringify(message))
  }

  #message(session: PeerSession, data: unknown): void {
    if (this.#current !== session) return
    try {
      if (typeof data !== "string" || data.length > MAX_TERMINAL_MESSAGE_BYTES) throw new Error("Invalid terminal message")
      const message = JSON.parse(data) as TerminalMessage
      if ("event" in message) {
        const event = message.event
        this.#event(event)
        const listener = this.#listeners.get(event.sessionId)
        const acknowledge = () => {
          if (event.kind !== "output" || this.#current !== session) return
          if (listener && this.#listeners.get(event.sessionId) !== listener) return
          try { this.#send({ ack: { sessionId: event.sessionId, offset: event.offset } }) }
          catch (error) { this.#fail(session, errorOf(error)) }
        }
        if (listener) listener(event, acknowledge)
        else acknowledge()
      } else {
        const request = this.#pending.get(message.id)
        if (!request) return
        clearTimeout(request.timeout)
        this.#pending.delete(message.id)
        if (message.error !== undefined) request.reject(new Error(message.error))
        else request.resolve(message.result)
      }
    } catch (error) {
      this.#fail(session, errorOf(error))
    }
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
    for (const request of this.#pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.#pending.clear()
    void this.#api.close(session.id).catch(() => {})
  }

  #fail(session: PeerSession, error: Error): void {
    if (this.#current !== session) return
    this.#release(session, error)
    this.#state("error", error.message)
    for (const [sessionId, listener] of this.#listeners) listener({ kind: "error", sessionId, error: error.message }, () => {})
  }

  close(): void {
    ++this.#generation
    this.#connecting = null
    if (this.#current) this.#release(this.#current, new Error("Terminal connection closed"))
    this.#listeners.clear()
    this.#state("idle")
  }
}
