import type { CentralApi } from "@deskfleet/client/central"
import type { DesktopCapabilities, IceCandidate } from "@deskfleet/client/desktop-media"
import type { NativeDesktopRequest } from "@deskfleet/client/native-desktop"
import { observePeerGrant, type PeerConnectionTelemetry } from "@deskfleet/client/peer-telemetry"

export type ViewerCommand =
  | { type: "start"; title: string; iceServers: { urls: string[]; username?: string; credential?: string }[]; relayOnly: boolean; control: boolean }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "close" }

export type ViewerEvent =
  | { type: "offer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "connected" | "closed" }
  | { type: "error"; error: string }
  | { type: "stats"; decodedFrames: number; submittedFrames: number; droppedFrames: number; width: number; height: number }

export interface ViewerProcess {
  send(command: ViewerCommand): void
  close(): Promise<void>
}
export type ViewerFactory = (event: (event: ViewerEvent) => void) => ViewerProcess

/** Signaling stays with the authenticated desktop host; only SDP/ICE crosses the pipe. */
export function openNativeDesktopSession(
  central: CentralApi,
  request: NativeDesktopRequest,
  spawn: ViewerFactory,
  failed: (error: Error) => void,
  ended: () => void,
): { ready: Promise<void>; close(): Promise<void> } {
  let peerId: string | undefined
  let viewer: ViewerProcess | undefined
  let telemetry: PeerConnectionTelemetry | undefined
  let closed = false, offered = false, connected = false, answered = false, starting = false, grantClosed = false
  let closing: Promise<void> | undefined
  let localSending = Promise.resolve()
  let expires: ReturnType<typeof setTimeout> | undefined
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const startup = setTimeout(() => fail(new Error("Native desktop connection timed out")), 20_000)

  function closeGrant(): void {
    if (!peerId || grantClosed) return
    grantClosed = true
    // Closing the local viewer must not wait for an unreachable signaling server.
    void central.closePeer(peerId).catch(error => console.error("Native desktop peer cleanup failed", error))
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    clearTimeout(startup); clearTimeout(expires); unsubscribe()
    rejectReady(new Error("Native desktop window closed"))
    closeGrant()
    closing = (viewer?.close() ?? Promise.resolve()).finally(ended)
    return closing
  }
  function fail(value: unknown): void {
    if (closed) return
    const error = value instanceof Error ? value : new Error(String(value))
    telemetry?.failed()
    rejectReady(error)
    void close().catch(error => console.error("Native desktop cleanup failed", error))
    failed(error)
  }
  function flushLocal(): void {
    if (!answered || closed) return
    const candidates = localCandidates.splice(0)
    localSending = localSending.then(async () => {
      for (const candidate of candidates) {
        if (closed) return
        try { await central.candidatePeer(peerId!, candidate) }
        catch (error) {
          if (!connected) throw error
          // A working ICE path does not depend on further trickle signaling.
          // Revocation, expiry and peer failures still close the session.
          if (!closed) console.warn("Native desktop ICE candidate send failed after connection", error)
        }
      }
    }).catch(fail)
  }
  async function startCapture(): Promise<void> {
    if (!answered || !connected || starting || closed) return
    starting = true
    await central.startPeer(peerId!, { displayId: request.displayId, ...(request.control ? { control: true } : {}) })
    if (closed) return
    clearTimeout(startup)
    telemetry?.connected()
    resolveReady()
  }
  async function offer(sdp: string): Promise<void> {
    if (offered) throw new Error("Native desktop sent a second offer")
    offered = true
    const answer = await central.offerPeer(peerId!, sdp, { sessionId: peerId!, sdp, codec: "h264", audio: false })
    if (closed) return
    viewer!.send({ type: "answer", sdp: answer.sdp })
    answered = true
    flushLocal()
    for (const candidate of remoteCandidates.splice(0)) viewer!.send({ type: "candidate", candidate })
    await startCapture()
  }
  function receive(event: ViewerEvent): void {
    if (closed) return
    try {
      switch (event.type) {
        case "offer": void offer(event.sdp).catch(fail); break
        case "candidate": localCandidates.push(event.candidate); flushLocal(); break
        case "connected": connected = true; void startCapture().catch(fail); break
        case "error": fail(new Error(event.error)); break
        case "closed": void close().catch(fail); break
        case "stats": break
      }
    } catch (error) { fail(error) }
  }
  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") { void close(); return }
    if ((event.type !== "peerEvent" && event.type !== "peerRevoked") || event.peerId !== peerId || closed) return
    if (event.type === "peerRevoked") { fail(new Error(event.reason)); return }
    const value = event.event
    try {
      if (value.kind === "iceCandidate" && "candidate" in value) {
        const candidate = value.candidate as IceCandidate
        if (answered) viewer!.send({ type: "candidate", candidate })
        else remoteCandidates.push(candidate)
      } else if (value.kind === "error") fail(new Error("error" in value ? String(value.error) : "Remote desktop failed"))
      else if (value.kind === "stateChanged" && "state" in value && ["failed", "closed"].includes(String(value.state).toLowerCase())) {
        fail(new Error("Remote desktop connection closed"))
      }
    } catch (error) { fail(error) }
  })
  async function negotiate(): Promise<void> {
    const machines = await central.machines(request.target.teamId)
    if (closed) return
    const machine = machines.find(machine => machine.id === request.target.machineId)
    if (!machine) throw new Error("Machine is no longer available in this team")
    const capabilities = await central.rpc<DesktopCapabilities>(request.target.teamId, machine.id, "capabilities", {})
    if (closed) return
    if (!capabilities.displays.some(display => display.id === request.displayId && display.codecs.includes("h264"))) {
      throw new Error("This display does not support H.264 for the native window")
    }
    const grant = await central.createPeer(request.target.teamId, machine.id, "desktop")
    peerId = grant.peerId
    if (closed) { closeGrant(); return }
    telemetry = observePeerGrant("desktop", grant, request.target.teamId)
    const expiry = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Desktop authorization has expired")
    expires = setTimeout(() => fail(new Error("Desktop authorization has expired. Reconnect to continue.")), expiry - Date.now())
    viewer = spawn(receive)
    if (closed) { await viewer.close(); return }
    viewer.send({
      type: "start", title: machine.name, control: request.control, relayOnly: false,
      iceServers: grant.iceServers.map(server => ({
        urls: typeof server.urls === "string" ? [server.urls] : server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
      })),
    })
  }
  void negotiate().catch(fail)
  return { ready, close }
}
