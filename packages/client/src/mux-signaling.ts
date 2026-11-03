import type { CentralApi } from "./central.ts"
import type { IceCandidate } from "./desktop-media.ts"
import { createPeerDisconnectGuard, PEER_SETUP_TIMEOUT_MS } from "./peer-lifecycle.ts"
import { observePeerGrant } from "./peer-telemetry.ts"
import { relayFailureError } from "./relay.ts"
import { MuxConnection } from "./mux/connection.ts"
import { MUX_LABELS, type MuxLane } from "./mux/protocol.ts"
import type { MuxPeer, MuxPeerFactory } from "./mux-peer.ts"

export interface MuxTarget { teamId: string; machineId: string }
export interface ConnectedMux { connection: MuxConnection; close(error?: Error): Promise<void> }

/** Only an explicit capability rejection permits switching to the legacy transport. */
export function isMuxUnsupported(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; message?: unknown } | null
  return value?.status === 400 && (value.code === "mux_unsupported"
    || (value.code === "invalid_request" && value.message === "unsupported peer purpose"))
    || value?.status === 502 && value.code === "operation_failed" && value.message === "Unsupported peer purpose"
}

export async function connectMachineMux(
  central: CentralApi, target: MuxTarget, factory: MuxPeerFactory, signal: AbortSignal,
  released: () => void,
): Promise<ConnectedMux | undefined> {
  let peer: MuxPeer | undefined, peerId: string | undefined, closed = false, remoteReady = false, offered = false
  let localSdp = "", remoteSdp = "", localSending = Promise.resolve(), remoteAdding = Promise.resolve()
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  const opened = new Set<MuxLane>()
  let unsubscribe = () => {}, lifetime: ReturnType<typeof setTimeout> | undefined
  let resolve!: () => void, reject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void ready.catch(() => {})
  let telemetry: ReturnType<typeof observePeerGrant> | undefined
  let relayReason: Parameters<typeof relayFailureError>[0]
  const disconnects = createPeerDisconnectGuard(() => fail(new Error("Machine peer disconnected"), true))
  const connection = new MuxConnection({ role: "client", send: (lane, bytes) => peer!.send(lane, bytes), failed: error => fail(error) })
  const setup = setTimeout(() => fail(new Error("Machine connection timed out"), true), PEER_SETUP_TIMEOUT_MS)
  async function close(error = new Error("Machine connection closed")): Promise<void> {
    if (closed) return
    closed = true; clearTimeout(setup); clearTimeout(lifetime); disconnects.clear(); unsubscribe()
    signal.removeEventListener("abort", aborted)
    reject(error); connection.close(error); released()
    await Promise.allSettled([peer?.close(), peerId ? central.closePeer(peerId) : undefined])
  }
  function fail(error: Error, transport = false): void {
    telemetry?.failed()
    void close(transport ? relayFailureError(relayReason, error) : error)
  }
  const aborted = () => { void close(new Error("Machine account changed")) }
  signal.addEventListener("abort", aborted, { once: true })
  function state(value: string): void {
    if (["failed", "closed"].includes(value.toLowerCase())) fail(new Error("Machine connection lost"), true)
    else disconnects.update(value)
  }
  function checkReady(): void {
    if (!closed && remoteReady && opened.size === Object.keys(MUX_LABELS).length) {
      clearTimeout(setup); telemetry?.connected(); resolve()
    }
  }
  function bound(value: IceCandidate, sdp: string): IceCandidate {
    if (value.sdpMid) return value
    const sections = sdp.split(/\r?\nm=/u).slice(1)
    const index = value.sdpMlineIndex ?? (sections.length === 1 ? 0 : -1)
    const mid = sections[index]?.match(/^a=mid:(.+)$/mu)?.[1]?.trim()
    if (!mid) throw new Error("Mux ICE candidate has no negotiated section")
    return { ...value, sdpMid: mid, sdpMlineIndex: index }
  }
  function flushLocal(): void {
    if (closed || !offered) return
    const values = localCandidates.splice(0)
    localSending = localSending.then(async () => {
      for (const value of values) { if (closed) return; await central.candidatePeer(peerId!, bound(value, localSdp)) }
    }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  }
  function flushRemote(): void {
    if (closed || !remoteReady) return
    const values = remoteCandidates.splice(0)
    remoteAdding = remoteAdding.then(async () => {
      for (const value of values) { if (closed) return; await peer!.candidate(bound(value, remoteSdp)) }
    }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  }
  async function negotiate(): Promise<boolean> {
    if (signal.aborted) { aborted(); throw new Error("Machine account changed") }
    let grant
    try { grant = await central.createPeer(target.teamId, target.machineId, "mux") }
    catch (error) { if (isMuxUnsupported(error)) return false; throw error }
    peerId = grant.peerId; relayReason = grant.relayDeniedReason
    if (closed) { await central.closePeer(peerId); throw new Error("Machine connection cancelled") }
    telemetry = observePeerGrant("mux", grant, target.teamId)
    const expires = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("Peer authorization has expired")
    lifetime = setTimeout(() => fail(new Error("Peer authorization has expired")), expires - Date.now())
    unsubscribe = central.onEvent(event => {
      if ((event.type !== "peerEvent" && event.type !== "peerRevoked") || event.peerId !== peerId) return
      if (event.type === "peerRevoked") {
        // The API revokes a rejected offer before returning its precise error.
        // Wait for that response to distinguish an old daemon from a failed negotiation.
        if (!offered && event.reason === "negotiation_failed") return
        fail(new Error(event.reason)); return
      }
      const value = event.event
      if (value.kind === "iceCandidate" && "candidate" in value) { remoteCandidates.push(value.candidate as IceCandidate); flushRemote() }
      else if (value.kind === "stateChanged" && "state" in value) state(String(value.state))
      else if (value.kind === "error") fail(new Error("error" in value ? String(value.error) : "Machine peer failed"))
    })
    peer = await factory(grant.iceServers, {
      data: (lane, bytes) => { if (!closed) connection.receive(lane, bytes) },
      open: lane => { opened.add(lane); checkReady() }, state, fail: error => fail(error, true),
      candidate: value => { localCandidates.push(value); flushLocal() },
    })
    if (closed) { await peer.close(); throw new Error("Machine connection cancelled") }
    localSdp = await peer.offer()
    if (closed) throw new Error("Machine connection cancelled")
    let answer
    try { answer = await central.offerPeer(peerId, localSdp) }
    catch (error) { if (isMuxUnsupported(error)) return false; throw error }
    if (closed) throw new Error("Machine connection cancelled")
    offered = true; flushLocal(); remoteSdp = answer.sdp
    await peer.answer(remoteSdp)
    remoteReady = true; flushRemote(); checkReady()
    await ready
    return true
  }
  try {
    const supported = await Promise.race([negotiate(), ready.then(() => true)])
    if (!supported) { await close(); return undefined }
    return { connection, close }
  } catch (error) {
    telemetry?.failed(); await close(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
