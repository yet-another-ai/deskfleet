import { relayFailureMessage } from "./relay.ts"
import { observePeerGrant } from "./peer-telemetry.ts"
import type { CentralApi } from "./central.ts"
import type { IceCandidate } from "./desktop-media.ts"
import type { FileTarget } from "./files.ts"
import type { FileTransport } from "./files-rpc.ts"

export type MachineFileTarget = Extract<FileTarget, { kind: "machine" }>
export interface FilePeerEvents {
  data(bytes: Uint8Array): void; candidate(candidate: IceCandidate): void
  open(): void; fail(error: Error): void
}
export interface FilePeer extends FileTransport {
  offer(): Promise<string>; answer(sdp: string): Promise<void>; candidate(candidate: IceCandidate): Promise<void>
}
export type FilePeerFactory = (iceServers: RTCIceServer[], events: FilePeerEvents) => Promise<FilePeer>

/** Bind the native stack's empty mid to the actual negotiated media section. */
function boundCandidate(candidate: IceCandidate, sdp: string): IceCandidate {
  if (candidate.sdpMid) return candidate
  const sections = sdp.split(/\r?\nm=/u).slice(1)
  const index = candidate.sdpMlineIndex ?? (sections.length === 1 ? 0 : -1)
  const mid = sections[index]?.match(/^a=mid:(.+)$/mu)?.[1]?.trim()
  if (!mid) throw new Error("File ICE candidate has no negotiated media section")
  return { ...candidate, sdpMid: mid, sdpMlineIndex: index }
}

/** Authorization and signaling survive UI/machine navigation, but never account changes. */
export async function connectFilePeer(
  central: CentralApi, target: MachineFileTarget, factory: FilePeerFactory,
  receive: (bytes: Uint8Array) => void, failed: (error: Error) => void,
): Promise<FileTransport> {
  const grant = await central.createPeer(target.teamId, target.machineId, "files")
  const telemetry = observePeerGrant("files", grant, target.teamId)
  let peer: FilePeer | undefined
  let closed = false, opened = false, remoteReady = false, offered = false
  let localSdp = "", remoteSdp = ""
  let localSending = Promise.resolve(), remoteAdding = Promise.resolve()
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Negotiation can still be awaiting an answer when expiry or revocation arrives.
  void ready.catch(() => {})
  let unsubscribe = () => {}
  let lifetime: ReturnType<typeof setTimeout> | undefined
  const setup = setTimeout(() => connectionFailed(new Error("File connection timed out")), 20_000)
  async function close(): Promise<void> {
    if (closed) return
    closed = true; clearTimeout(setup); clearTimeout(lifetime); unsubscribe()
    rejectReady(new Error("File connection is closed"))
    await Promise.allSettled([peer?.close(), central.closePeer(grant.peerId)])
  }
  function fail(error: Error, connectionFailure = true): void {
    if (closed) return
    if (connectionFailure) telemetry.failed()
    rejectReady(error); failed(error)
    void close()
  }
  function connectionFailed(error: Error): void {
    const detail = relayFailureMessage(grant.relayDeniedReason)
    fail(detail ? new Error(detail) : error)
  }
  function checkReady(): void {
    if (opened && remoteReady && !closed) { clearTimeout(setup); telemetry.connected(); resolveReady() }
  }
  function flushLocal(): void {
    if (!offered || closed) return
    const values = localCandidates.splice(0)
    localSending = localSending.then(async () => {
      for (const candidate of values) {
        if (closed) return
        await central.candidatePeer(grant.peerId, boundCandidate(candidate, localSdp))
      }
    }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  }
  function flushRemote(): void {
    if (!remoteReady || closed) return
    const values = remoteCandidates.splice(0)
    remoteAdding = remoteAdding.then(async () => {
      for (const candidate of values) {
        if (closed) return
        await peer!.candidate(boundCandidate(candidate, remoteSdp))
      }
    }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  }
  unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") { fail(new Error("Account changed; reconnect files"), false); return }
    if ((event.type !== "peerEvent" && event.type !== "peerRevoked") || event.peerId !== grant.peerId) return
    if (event.type === "peerRevoked") { fail(new Error(event.reason), false); return }
    const value = event.event
    if (value.kind === "iceCandidate" && "candidate" in value) { remoteCandidates.push(value.candidate as IceCandidate); flushRemote() }
    else if (value.kind === "error") fail(new Error("error" in value ? String(value.error) : "File peer failed"))
    else if (value.kind === "stateChanged" && "state" in value && ["failed", "closed"].includes(String(value.state))) connectionFailed(new Error("File peer closed"))
  })
  async function negotiate(): Promise<void> {
    const expires = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("File authorization expired")
    lifetime = setTimeout(() => fail(new Error("File authorization expired; reconnect to continue"), false), expires - Date.now())
    peer = await factory(grant.iceServers, {
      data: bytes => { if (!closed) receive(bytes) },
      candidate: candidate => { localCandidates.push(candidate); flushLocal() },
      open: () => { opened = true; checkReady() }, fail: connectionFailed,
    })
    if (closed) { await peer.close(); throw new Error("File connection was cancelled") }
    localSdp = await peer.offer()
    if (closed) throw new Error("File connection was cancelled")
    const answer = await central.offerPeer(grant.peerId, localSdp)
    if (closed) throw new Error("File connection was cancelled")
    offered = true; flushLocal(); remoteSdp = answer.sdp
    await peer.answer(remoteSdp)
    remoteReady = true; flushRemote(); checkReady()
    await ready
  }
  try {
    // A stalled offer or native factory must not hold callers past revocation or
    // the setup deadline. A late factory result is closed by negotiate above.
    await Promise.race([negotiate(), ready])
    return { async send(bytes) { if (closed) throw new Error("File connection is closed"); await peer!.send(bytes) }, close }
  } catch (error) { if (!closed) telemetry.failed(); void close(); throw error }
}
