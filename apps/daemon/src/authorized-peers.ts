import type { NativePeer } from "@deskfleet/native"
import { isDeepStrictEqual } from "node:util"
import { AgentChannel, type AgentChannelSessions } from "./agent-channel.ts"
import { AGENT_CHANNEL, type AgentMethod } from "./agent-protocol.ts"
import type { ControlPeers } from "./control-server.ts"
import { desktopErrorEvent, desktopStartupCleanupFailure, encoderFailure, type DesktopStart, type IceCandidate } from "./control-protocol.ts"
import type { MachineCredentials, PeerAuthorization, PeerOffer, PeerSignal } from "./central-protocol.ts"
import { TerminalChannel } from "./terminal-channel.ts"
import { TERMINAL_CHANNEL } from "./terminal-protocol.ts"
import { DesktopInputChannel } from "./desktop-input.ts"
import type { TerminalSessions } from "./terminals.ts"
import { FilesChannel, fileAction } from "./files-channel.ts"
import { FILES_CHANNEL } from "./files-protocol.ts"
import { FilesService } from "./files-service.ts"

const DAY_MS = 86_400_000
const AGENT_READ = new Set<AgentMethod>([
  "_deskfleet/session/list", "_deskfleet/session/subscribe", "_deskfleet/session/history", "_deskfleet/command/get",
  "_deskfleet/session/configuration", "_deskfleet/agent/configuration",
])
const AGENT_EXECUTE = new Set<AgentMethod>([
  "_deskfleet/input/submit", "_deskfleet/input/steer", "_deskfleet/input/withdraw", "_deskfleet/input/retry",
  "_deskfleet/turn/cancel", "_deskfleet/permission/respond", "_deskfleet/session/resume", "_deskfleet/session/stop",
  "_deskfleet/elicitation/respond",
])

interface AuthorizedPeer {
  authorization: PeerAuthorization
  native: Promise<NativePeer>
  timer: ReturnType<typeof setTimeout>
  remoteSdp: string
  localSdp?: string
  terminal?: TerminalChannel
  agent?: AgentChannel
  files?: FilesChannel
  input?: DesktopInputChannel
  desktopStart?: "starting" | "started"
}

/** Resolve the empty mid emitted by native WebRTC from the authenticated SDP. */
export function normalizeCandidate(candidate: IceCandidate, sdp: string): IceCandidate {
  const sections = sdp.split(/\r?\nm=/u).slice(1)
  const mids = sections.map(section => /^a=mid:(.+)$/mu.exec(section)?.[1]?.trim())
  const index = candidate.sdpMlineIndex ?? (candidate.sdpMid ? mids.indexOf(candidate.sdpMid) : sections.length === 1 ? 0 : -1)
  if (index < 0 || index >= sections.length || !mids[index]) throw new Error("ICE candidate does not identify a negotiated media section")
  if (candidate.sdpMid && candidate.sdpMid !== mids[index]) throw new Error("ICE candidate media binding does not match SDP")
  const ufrag = /^a=ice-ufrag:(.+)$/mu.exec(sections[index]!)?.[1]?.trim() ?? /^a=ice-ufrag:(.+)$/mu.exec(sdp.split(/\r?\nm=/u)[0]!)?.[1]?.trim()
  if (candidate.usernameFragment && candidate.usernameFragment !== ufrag) throw new Error("ICE candidate belongs to another negotiation")
  return { ...candidate, sdpMid: mids[index], sdpMlineIndex: index }
}

/** Peer lifetime belongs to its immutable grant, never to a signaling socket. */
export class AuthorizedPeers {
  readonly #native: ControlPeers
  readonly #agents: AgentChannelSessions
  readonly #terminals: TerminalSessions
  readonly #signal: (peerId: string, event: PeerSignal) => void
  readonly #now: () => number
  readonly #peers = new Map<string, AuthorizedPeer>()
  readonly #closing = new Map<string, Promise<void>>()
  readonly #used = new Map<string, number>()
  #credentials: MachineCredentials | undefined
  #identity: { originId: string; machineId: string }

  constructor(options: {
    peers: ControlPeers; agents: AgentChannelSessions; terminals: TerminalSessions
    identity: { originId: string; machineId: string }
    signal: (peerId: string, event: PeerSignal) => void; now?: () => number
  }) {
    this.#native = options.peers; this.#agents = options.agents; this.#terminals = options.terminals
    this.#identity = options.identity; this.#signal = options.signal; this.#now = options.now ?? Date.now
  }

  bind(credentials: MachineCredentials): void { this.#credentials = credentials }

  #validate(grant: PeerAuthorization): void {
    const target = grant.targetMachine, bound = this.#credentials
    const issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt)
    if (!bound || grant.serverId !== bound.serverId || grant.teamId !== bound.teamId || target.id !== bound.machineId ||
      target.originId !== this.#identity.originId || target.localMachineId !== this.#identity.machineId) throw new Error("Peer grant targets another machine or authority")
    if (grant.actor.kind !== "user" || !grant.actor.userId || !grant.actor.deviceId) throw new Error("Peer grant requires an authenticated user")
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > this.#now() + 60_000 || expires <= this.#now() || expires <= issued || expires - issued > DAY_MS) {
      throw new Error("Peer authorization is expired or exceeds 24 hours")
    }
    if (!["agent", "terminal", "desktop", "files"].includes(grant.purpose)) throw new Error("Unsupported peer purpose")
  }

  #live(id: string, action?: string): AuthorizedPeer {
    const peer = this.#peers.get(id)
    if (!peer) throw new Error("Unknown authorized peer")
    if (Date.parse(peer.authorization.expiresAt) <= this.#now()) {
      void this.close(id).catch(() => {})
      throw new Error("Peer authorization has expired")
    }
    if (action && !peer.authorization.actions.includes(action)) throw new Error("Peer grant does not allow this operation")
    return peer
  }

  async offer(params: PeerOffer): Promise<{ sdp: string }> {
    this.#validate(params.authorization)
    if (params.peerId !== params.authorization.peerId || !params.peerId) throw new Error("Peer ID does not match its authorization")
    for (const [id, expires] of this.#used) if (expires <= this.#now()) this.#used.delete(id)
    if (this.#used.has(params.peerId)) throw new Error("Create a new peer for another negotiation")
    if (!/^a=fingerprint:sha-256 [\dA-Fa-f:]+\r?$/mu.test(params.sdp)) throw new Error("An authenticated DTLS SHA-256 fingerprint is required")
    const purpose = params.authorization.purpose
    const native = this.#native.create(params.peerId, {
      iceServers: params.iceServers,
      ...(purpose === "desktop" ? { video: params.options?.codec ?? "h264", audio: params.options?.audio ?? false } : {}),
    })
    const owned: AuthorizedPeer = {
      authorization: structuredClone(params.authorization), native, remoteSdp: params.sdp,
      timer: setTimeout(() => { void this.close(params.peerId).catch(error => console.error("Expired peer cleanup failed", error)) }, Date.parse(params.authorization.expiresAt) - this.#now()),
    }
    owned.timer.unref()
    this.#used.set(params.peerId, Date.parse(params.authorization.expiresAt))
    this.#peers.set(params.peerId, owned)
    try {
      const peer = await native
      this.#live(params.peerId)
      const failure = (error: unknown) => {
        this.#signal(params.peerId, { kind: "error", error: error instanceof Error ? error.message : String(error) })
        void this.close(params.peerId).catch(cleanup => console.error("Peer cleanup failed", cleanup))
      }
      if (purpose === "agent") {
        const sessions: AgentChannelSessions = {
          journal: this.#agents.journal,
          onEvent: listener => this.#agents.onEvent(event => {
            try { this.#live(params.peerId, "agent:read"); listener(event) } catch { /* expiry closes subscriptions */ }
          }),
          watchGit: async (sessionId, _actor, listener) => {
            this.#live(params.peerId, "git:read")
            if (!this.#agents.watchGit) throw new Error("Git observation is unavailable")
            return this.#agents.watchGit(sessionId, owned.authorization.actor, error => {
              try { this.#live(params.peerId, "git:read"); listener(error) } catch { /* expiry closes subscriptions */ }
            })
          },
          handle: (method, value) => {
            const scope = AGENT_READ.has(method) ? "agent:read" : AGENT_EXECUTE.has(method) ? "agent:execute" : method.startsWith("_deskfleet/git/") ? "git:read" : undefined
            if (!scope) return Promise.reject(new Error("Manage Sessions through the backend API"))
            this.#live(params.peerId, scope)
            return this.#agents.handle(method, value, owned.authorization.actor)
          },
        }
        owned.agent = new AgentChannel(sessions, owned.authorization.actor, bytes => {
          this.#live(params.peerId, "agent:read")
          return peer.sendData(AGENT_CHANNEL, Buffer.from(bytes))
        }, failure)
      }
      if (purpose === "terminal") {
        owned.terminal = new TerminalChannel(this.#terminals, text => {
          this.#live(params.peerId, "terminal:read")
          return peer.sendText(TERMINAL_CHANNEL, text)
        }, failure, id => {
          this.#live(params.peerId, "terminal:write")
          return this.#terminals.list().some(terminal => terminal.id === id)
        })
      }
      if (purpose === "files") {
        owned.files = new FilesChannel(
          new FilesService(this.#agents.sessionDirectory ? sessionId => this.#agents.sessionDirectory!(sessionId) : undefined),
          data => peer.sendData(FILES_CHANNEL, Buffer.from(data)),
          method => { this.#live(params.peerId, fileAction(method)) },
          failure,
        )
      }
      if (purpose === "desktop") owned.input = new DesktopInputChannel(peer, () => { this.#live(params.peerId, "desktop:control") })
      // Candidate events can race answerOffer. Hold them until the answer SDP is bound.
      const answer = await peer.answerOffer(params.sdp)
      this.#live(params.peerId)
      owned.localSdp = answer
      void this.#events(params.peerId, owned, peer)
      return { sdp: answer }
    } catch (error) { await this.close(params.peerId); throw error }
  }

  async candidate(id: string, candidate: IceCandidate): Promise<void> {
    const owned = this.#live(id)
    await (await owned.native).addIceCandidate(normalizeCandidate(candidate, owned.remoteSdp))
  }

  async start(id: string, options: Omit<DesktopStart, "sessionId">): Promise<void> {
    const owned = this.#live(id, "desktop:stream")
    if (owned.authorization.purpose !== "desktop") throw new Error("A desktop peer is required")
    if (options.control) this.#live(id, "desktop:control")
    if (owned.desktopStart) throw new Error(`Desktop stream is already ${owned.desktopStart}`)
    owned.desktopStart = "starting"
    const native = await owned.native
    try {
      this.#live(id, "desktop:stream")
      await native.startDesktop(options)
      this.#live(id, "desktop:stream")
      if (options.control) await owned.input!.enable()
      this.#live(id, "desktop:stream")
      owned.desktopStart = "started"
    } catch (error) {
      const failure = native.takeMediaFailure?.()
      const startupError = failure?.reason === "encoder" ? encoderFailure(failure.message) : error
      try { await this.close(id) }
      catch (cleanup) {
        throw desktopStartupCleanupFailure(startupError, cleanup)
      }
      throw startupError
    }
  }

  async reconcile(grants: PeerAuthorization[]): Promise<void> {
    const valid = new Map(grants.map(grant => [grant.peerId, grant]))
    await Promise.all([...this.#peers].map(async ([id, peer]) => {
      const grant = valid.get(id)
      // Reconciliation never replaces or extends an existing authorization.
      if (!grant || !isDeepStrictEqual(grant, peer.authorization) || Date.parse(grant.expiresAt) <= this.#now()) await this.close(id)
    }))
  }

  async #events(id: string, owned: AuthorizedPeer, peer: NativePeer): Promise<void> {
    try {
      while (this.#peers.get(id) === owned) {
        const event = await peer.nextEvent()
        if (this.#peers.get(id) !== owned) return
        if (!event) break
        this.#live(id)
        await owned.input?.receive(event)
        if (event.kind === "data" && event.data) {
          if (owned.agent && event.label === AGENT_CHANNEL) owned.agent.receive(event.data, event.isString === true)
          if (owned.files && event.label === FILES_CHANNEL) owned.files.receive(event.data, event.isString === true)
          if (owned.terminal && event.label === TERMINAL_CHANNEL) {
            this.#live(id, "terminal:write")
            void owned.terminal.receive(event.data, event.isString === true).catch(error => {
              this.#signal(id, { kind: "error", error: String(error) }); void this.close(id).catch(() => {})
            })
          }
        }
        if (event.kind === "iceCandidate" && event.candidate) this.#signal(id, { kind: "iceCandidate", candidate: normalizeCandidate(event.candidate, owned.localSdp!) })
        if (event.kind === "stateChanged" && event.state) this.#signal(id, { kind: "stateChanged", state: event.state })
        if (event.kind === "error") {
          const reported = desktopErrorEvent(id, event.error ?? "Peer failed", event.reason)
          this.#signal(id, { kind: "error", error: reported.error, ...(reported.reason ? { reason: reported.reason } : {}) })
        }
        if (event.kind === "error" || event.state === "failed" || event.state === "closed" || event.kind === "dataChannelClosed") break
      }
    } catch (error) {
      if (this.#peers.get(id) === owned) this.#signal(id, { kind: "error", error: error instanceof Error ? error.message : String(error) })
    } finally { await this.close(id).catch(error => console.error("Peer cleanup failed", error)) }
  }

  async close(id: string): Promise<void> {
    const closing = this.#closing.get(id)
    if (closing) return closing
    const peer = this.#peers.get(id)
    if (!peer) return
    this.#peers.delete(id)
    clearTimeout(peer.timer)
    peer.agent?.close(); peer.terminal?.close()
    peer.input?.close()
    const pending = Promise.allSettled([peer.files?.close(), this.#native.close(id)]).then(results => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, "Failed to close authorized peer")
    })
    this.#closing.set(id, pending)
    try { await pending }
    finally { this.#closing.delete(id) }
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...new Set([...this.#peers.keys(), ...this.#closing.keys()])].map(id => this.close(id)))
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Failed to close authorized peers")
  }
}
