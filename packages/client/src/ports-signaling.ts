import type { CentralApi } from "./central.ts"
import type { IceCandidate } from "./desktop-media.ts"

export interface PortPeerEvents {
  candidate(candidate: IceCandidate): void
  open(): void
  fail(error: Error): void
}
export interface PortConnection {
  localPort: number
  close(): Promise<void>
}
export interface PortPeer extends PortConnection {
  offer(): Promise<string>
  answer(sdp: string): Promise<void>
  candidate(candidate: IceCandidate): Promise<void>
}
export type PortPeerFactory = (iceServers: RTCIceServer[], events: PortPeerEvents) => Promise<PortPeer>

function boundCandidate(candidate: IceCandidate, sdp: string): IceCandidate {
  if (candidate.sdpMid) return candidate
  const sections = sdp.split(/\r?\nm=/u).slice(1)
  const index = candidate.sdpMlineIndex ?? (sections.length === 1 ? 0 : -1)
  const mid = sections[index]?.match(/^a=mid:(.+)$/mu)?.[1]?.trim()
  if (!mid) throw new Error("Port ICE candidate has no negotiated media section")
  return { ...candidate, sdpMid: mid, sdpMlineIndex: index }
}
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** Main-process signaling owns a tunnel independently of renderer navigation. */
export async function connectPortPeer(
  central: CentralApi, target: { teamId: string; machineId: string }, factory: PortPeerFactory,
  failed: (error: Error) => void, signal?: AbortSignal,
): Promise<PortConnection> {
  let peerId: string | undefined, peer: PortPeer | undefined
  let closed = false, opened = false, remoteReady = false, offered = false, grantClosed = false
  let localSdp = "", remoteSdp = ""
  let localSending = Promise.resolve(), remoteAdding = Promise.resolve()
  let nativeClosing: Promise<void> | undefined, closing: Promise<void> | undefined
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  let unsubscribe = () => {}
  let lifetime: ReturnType<typeof setTimeout> | undefined
  const setup = setTimeout(() => fail(new Error("Port connection timed out")), 20_000)
  function closeGrant(): void {
    if (!peerId || grantClosed) return
    grantClosed = true
    // Local sockets must close even if the signaling server is unreachable.
    void central.closePeer(peerId).catch(() => {})
  }
  function closeNative(): Promise<void> {
    if (peer) nativeClosing ??= peer.close()
    return nativeClosing ?? Promise.resolve()
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    clearTimeout(setup); clearTimeout(lifetime); unsubscribe()
    signal?.removeEventListener("abort", abort)
    rejectReady(new Error("Port connection is closed"))
    closeGrant()
    closing = closeNative()
    return closing
  }
  function fail(error: Error): void {
    if (closed) return
    rejectReady(error)
    void close().catch(() => {})
    failed(error)
  }
  function abort(): void { fail(new Error("Port connection was cancelled")) }
  function checkReady(): void {
    if (opened && remoteReady && !closed) { clearTimeout(setup); resolveReady() }
  }
  function flushLocal(): void {
    if (!offered || closed) return
    const values = localCandidates.splice(0)
    localSending = localSending.then(async () => {
      for (const candidate of values) {
        if (closed) return
        await central.candidatePeer(peerId!, boundCandidate(candidate, localSdp))
      }
    }).catch(error => fail(asError(error)))
  }
  function flushRemote(): void {
    if (!remoteReady || closed) return
    const values = remoteCandidates.splice(0)
    remoteAdding = remoteAdding.then(async () => {
      for (const candidate of values) {
        if (closed) return
        await peer!.candidate(boundCandidate(candidate, remoteSdp))
      }
    }).catch(error => fail(asError(error)))
  }
  unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") { fail(new Error("Account changed; reconnect ports")); return }
    if ((event.type !== "peerEvent" && event.type !== "peerRevoked") || event.peerId !== peerId) return
    if (event.type === "peerRevoked") { fail(new Error(event.reason)); return }
    const value = event.event
    if (value.kind === "iceCandidate" && "candidate" in value) {
      remoteCandidates.push(value.candidate as IceCandidate); flushRemote()
    } else if (value.kind === "error") fail(new Error("error" in value ? String(value.error) : "Port peer failed"))
    else if (value.kind === "stateChanged" && "state" in value && ["failed", "closed"].includes(String(value.state))) {
      fail(new Error("Port peer closed"))
    }
  })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  async function negotiate(): Promise<void> {
    if (closed) return
    const grant = await central.createPeer(target.teamId, target.machineId, "ports")
    peerId = grant.peerId
    if (closed) { closeGrant(); return }
    const expires = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("Port authorization expired")
    lifetime = setTimeout(() => fail(new Error("Port authorization expired; reconnect to continue")), expires - Date.now())
    peer = await factory(grant.iceServers, {
      candidate: value => { localCandidates.push(value); flushLocal() },
      open: () => { opened = true; checkReady() }, fail,
    })
    if (closed) { await closeNative(); return }
    localSdp = await peer.offer()
    if (closed) return
    const answer = await central.offerPeer(peerId, localSdp)
    if (closed) return
    offered = true; flushLocal(); remoteSdp = answer.sdp
    await peer.answer(remoteSdp)
    if (closed) return
    remoteReady = true; flushRemote(); checkReady()
    await ready
  }
  try {
    await Promise.race([negotiate(), ready])
    if (closed || !peer) throw new Error("Port connection is closed")
    return { localPort: peer.localPort, close }
  } catch (error) {
    void close().catch(() => {})
    throw error
  }
}
