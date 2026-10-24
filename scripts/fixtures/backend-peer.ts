import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { createPeer, type IceCandidate, type IceServer } from "../../crates/node/index.ts"
import { AGENT_CHANNEL } from "../../apps/daemon/src/agent-protocol.ts"
import type { PeerAuthorization } from "../../apps/daemon/src/central-protocol.ts"
import { normalizeCandidate } from "../../apps/daemon/src/authorized-peers.ts"
import { TERMINAL_CHANNEL, type TerminalEvent } from "../../apps/daemon/src/terminal-protocol.ts"

export type BackendRequest = <T>(path: string, body?: unknown, method?: string) => Promise<T>
export async function until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(20)
  }
}

type Message = { id?: number; result?: unknown; error?: unknown; event?: TerminalEvent; method?: string; params?: unknown }

/** Real native WebRTC peer using only the application's authenticated signaling routes. */
export async function connectBackendPeer(options: {
  backend: string; token: string; teamId: string; machineId: string; purpose: "agent" | "terminal"; request: BackendRequest; relayOnly?: boolean
}) {
  const { request, purpose } = options
  const grant = await request<{ peerId: string; authorization: PeerAuthorization; iceServers: IceServer[] }>("/peers", {
    teamId: options.teamId, machineId: options.machineId, purpose,
  })
  const relayOnly = options.relayOnly ?? process.env.DESKFLEET_SMOKE_RELAY_ONLY === "1"
  if (relayOnly) assert.ok(grant.iceServers.some(server => server.urls.some(url => /^turns?:/u.test(url))), "Relay smoke requires TURN credentials")
  const peer = await createPeer({ iceServers: grant.iceServers, relayOnly })
  const channel = purpose === "agent" ? AGENT_CHANNEL : TERMINAL_CHANNEL
  const socket = new WebSocket(`${options.backend.replace(/^http/u, "ws")}/api/client/ws`)
  const errors: unknown[] = []
  const messages: Message[] = []
  const remoteCandidates: IceCandidate[] = []
  const localCandidates: IceCandidate[] = []
  const gatheredCandidates: IceCandidate[] = []
  let ready = false, opened = false, answered = false, closed = false, disconnected = false
  let offerSdp = ""
  let fragments = Buffer.alloc(0)
  let nextId = 0
  const observed = (work: Promise<unknown>) => { void work.catch(error => { if (!closed) errors.push(error) }) }
  const sendCandidate = (candidate: IceCandidate) => request(`/peers/${grant.peerId}/candidate`, { candidate: normalizeCandidate(candidate, offerSdp) })
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "authenticate", token: options.token })))
  socket.addEventListener("error", () => { if (!closed && !opened) errors.push(new Error("Client signaling socket failed")) })
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data))
    if (message.type === "ready") ready = true
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }))
    if (message.type === "peerEvent" && message.peerId === grant.peerId) {
      if (message.event.kind === "iceCandidate") {
        if (answered) observed(peer.addIceCandidate(message.event.candidate))
        else remoteCandidates.push(message.event.candidate)
      }
      if (message.event.kind === "error") errors.push(new Error(message.event.error))
    }
  })
  const pump = (async () => {
    for (;;) {
      const event = await peer.nextEvent()
      if (!event || closed) { disconnected = true; return }
      if (event.kind === "dataChannelClosed" && event.label === channel || event.kind === "stateChanged" && ["failed", "closed"].includes(event.state ?? "")) disconnected = true
      if (event.kind === "error") throw new Error(event.error!)
      if (event.kind === "iceCandidate") {
        gatheredCandidates.push(event.candidate!)
        if (answered) observed(sendCandidate(event.candidate!))
        else localCandidates.push(event.candidate!)
      }
      if (event.kind === "dataChannelOpen" && event.label === channel) opened = true
      if (event.kind === "data") {
        assert.equal(event.label, channel)
        if (purpose === "terminal") {
          assert.equal(event.isString, true)
          const message = JSON.parse(event.data!.toString("utf8")) as Message
          messages.push(message)
          if (message.event?.kind === "output") {
            const output = message.event
            observed(peer.sendText(channel, JSON.stringify({ ack: { sessionId: output.sessionId, offset: output.offset } })))
          }
        } else {
          assert.equal(event.isString, false)
          fragments = Buffer.concat([fragments, event.data!])
          for (let index = fragments.indexOf(10); index >= 0; index = fragments.indexOf(10)) {
            messages.push(JSON.parse(fragments.subarray(0, index).toString("utf8")))
            fragments = fragments.subarray(index + 1)
          }
        }
      }
    }
  })().catch(error => { if (!closed) errors.push(error) })
  const check = () => { if (errors.length) throw errors[0] }
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    socket.close()
    await peer.close()
    await pump
    await request(`/peers/${grant.peerId}`, undefined, "DELETE").catch(() => {})
  }
  try {
    await until(() => { check(); return ready }, Boolean, "client signaling authentication")
    await peer.createDataChannel(channel)
    offerSdp = await peer.createOffer()
    const answer = await request<{ sdp: string }>(`/peers/${grant.peerId}/offer`, { sdp: offerSdp })
    await peer.acceptAnswer(answer.sdp)
    answered = true
    await Promise.all([
      ...remoteCandidates.map(candidate => peer.addIceCandidate(candidate)),
      ...localCandidates.map(sendCandidate),
    ])
    await until(() => { check(); return opened }, Boolean, `${purpose} DataChannel`)
    if (relayOnly) {
      assert.ok(gatheredCandidates.some(candidate => / typ relay(?: |$)/u.test(candidate.candidate)), "The peer must gather a TURN relay candidate")
      assert.ok(gatheredCandidates.every(candidate => !/ typ (?:host|srflx)(?: |$)/u.test(candidate.candidate)), "Relay-only peers must not expose direct candidates")
    }
    async function rpc<T>(method: string, params: unknown): Promise<T> {
      check()
      if (disconnected) throw new Error("Peer connection is closed")
      const id = nextId++
      const value = { ...(purpose === "agent" ? { jsonrpc: "2.0" } : {}), id, method, params }
      if (purpose === "agent") await peer.sendData(channel, Buffer.from(`${JSON.stringify(value)}\n`))
      else await peer.sendText(channel, JSON.stringify(value))
      const response = await until(() => { check(); return messages.find(message => message.id === id) }, value => !!value, method)
      if (response!.error) throw new Error(JSON.stringify(response!.error))
      return response!.result as T
    }
    if (purpose === "agent") assert.equal((await rpc<{ protocolVersion: number }>("initialize", { protocolVersion: 1 })).protocolVersion, 1)
    return { rpc, close, messages, authorization: grant.authorization, check, disconnected: () => disconnected }
  } catch (error) { await close(); throw error }
}
