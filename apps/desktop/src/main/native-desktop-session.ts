import type { CentralApi } from "@deskfleet/client/central"
import type { DesktopCapabilities, IceCandidate, VideoCodec } from "@deskfleet/client/desktop-media"
import type { NativeDesktopRequest } from "@deskfleet/client/native-desktop"
import { createPeerDisconnectGuard, PEER_SETUP_TIMEOUT_MS } from "@deskfleet/client/peer-lifecycle"
import { observePeerGrant, type PeerConnectionTelemetry } from "@deskfleet/client/peer-telemetry"

export type ViewerCommand =
  | { type: "start"; title: string; codec: VideoCodec; width: number; height: number; iceServers: { urls: string[]; username?: string; credential?: string }[]; relayOnly: boolean; control: boolean }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "close" }

export type ViewerEvent =
  | { type: "capabilities"; codecs: VideoCodec[] }
  | { type: "offer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "answerApplied" | "inputReady" | "videoReady" | "connected" | "disconnected" | "closeRequested" | "closed" }
  | { type: "error"; error: string; reason?: "decoder" }
  | { type: "stats"; decodedFrames: number; submittedFrames: number; droppedFrames: number; width: number; height: number }

export interface ViewerProcess {
  send(command: ViewerCommand): void
  close(): Promise<void>
}
export type ViewerFactory = (event: (event: ViewerEvent) => void) => ViewerProcess

/** Signaling stays with the authenticated desktop host; only SDP/ICE crosses the pipe. */
export function openNativeDesktopSession(
  central: CentralApi, request: NativeDesktopRequest, spawn: ViewerFactory,
  failed: (error: Error) => void, ended: () => void,
): { ready: Promise<void>; close(): Promise<void> } {
  let current: ReturnType<typeof openAttempt> | undefined
  let closed = false, opened = false, finished = false
  const finish = () => { if (!finished) { finished = true; ended() } }
  const excluded = new Set<VideoCodec>()
  const ready = (async () => {
    while (!closed) {
      current = openAttempt(central, request, spawn, error => {
        if (opened) { failed(error); finish() }
      }, () => { if (opened || closed) finish() }, excluded)
      try { await current.ready; opened = true; return }
      catch (value) {
        await current.close()
        const error = value as Error & { reason?: string; codec?: VideoCodec }
        if (!closed && error.codec && ["encoder", "decoder"].includes(error.reason ?? "")) {
          try { await current.release() }
          catch (cleanup) {
            const failure = new AggregateError([error, cleanup], "Cannot release the previous native desktop peer")
            failed(failure); finish(); throw failure
          }
          if (closed) throw new Error("Native desktop window closed")
          excluded.add(error.codec)
          continue
        }
        if (!closed && error.message !== "Native desktop window closed") failed(error)
        finish()
        throw error
      }
    }
    throw new Error("Native desktop window closed")
  })()
  void ready.catch(() => {})
  return { ready, async close() { closed = true; await current?.close(); finish() } }
}

function openAttempt(
  central: CentralApi,
  request: NativeDesktopRequest,
  spawn: ViewerFactory,
  failed: (error: Error) => void,
  ended: () => void,
  excluded: Set<VideoCodec>,
): { ready: Promise<void>; close(): Promise<void>; release(): Promise<void> } {
  let peerId: string | undefined
  let viewer: ViewerProcess | undefined
  let telemetry: PeerConnectionTelemetry | undefined
  let closed = false, offered = false, connected = false, answered = false, answerApplied = false, starting = false, started = false
  let grantClosing: Promise<void> | undefined
  let inputReady = !request.control
  let videoReady = false
  let readyResolved = false
  let startPending = false
  let startFailure: Error | undefined
  let selectedCodec: VideoCodec | undefined
  let remoteCodecs: VideoCodec[] = []
  let startCommand: Omit<Extract<ViewerCommand, { type: "start" }>, "codec"> | undefined
  let closing: Promise<void> | undefined
  let localSending = Promise.resolve()
  let expires: ReturnType<typeof setTimeout> | undefined
  let inputTimeout: ReturnType<typeof setTimeout> | undefined
  const localDisconnects = createPeerDisconnectGuard(() => transportFailed(new Error("Native desktop connection lost")))
  const remoteDisconnects = createPeerDisconnectGuard(() => transportFailed(new Error("Remote desktop connection lost")))
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const startup = setTimeout(() => fail(new Error("Native desktop connection timed out")), PEER_SETUP_TIMEOUT_MS)

  function closeGrant(): Promise<void> {
    if (!peerId) return Promise.resolve()
    if (grantClosing) return grantClosing
    // Closing the local viewer must not wait for an unreachable signaling server.
    grantClosing = central.closePeer(peerId)
    void grantClosing.catch(error => console.error("Native desktop peer cleanup failed", error))
    return grantClosing
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    clearTimeout(startup); clearTimeout(expires); clearTimeout(inputTimeout); unsubscribe()
    localDisconnects.clear(); remoteDisconnects.clear()
    rejectReady(new Error("Native desktop window closed"))
    closeGrant()
    closing = (viewer?.close() ?? Promise.resolve()).finally(ended)
    return closing
  }
  function fail(value: unknown): void {
    if (closed) return
    const error = value instanceof Error ? value : new Error(String(value))
    if (selectedCodec && "reason" in error && ["encoder", "decoder"].includes(String(error.reason))) Object.assign(error, { codec: selectedCodec })
    telemetry?.failed()
    rejectReady(error)
    void close().catch(error => console.error("Native desktop cleanup failed", error))
    failed(error)
  }
  function transportFailed(error: Error): void {
    // Encoder startup closes the remote peer before its RPC rejection arrives.
    // Preserve that rejection's reason so it can select the next codec.
    if (startPending) startFailure ??= error
    else fail(error)
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
    if (!answerApplied || !connected || starting || closed) return
    starting = true
    startPending = true
    try {
      await central.startPeer(peerId!, { displayId: request.displayId, ...(request.control ? { control: true } : {}) })
    } finally { startPending = false }
    if (closed) return
    if (startFailure) throw startFailure
    started = true
    finishStartup()
    if (!inputReady) inputTimeout = setTimeout(() => fail(new Error("Native desktop input readiness timed out")), 10_000)
  }
  function finishStartup(): void {
    if (started && inputReady && videoReady && !closed && !readyResolved) {
      readyResolved = true
      telemetry?.connected()
      clearTimeout(startup)
      clearTimeout(inputTimeout)
      resolveReady()
    }
  }
  async function offer(sdp: string): Promise<void> {
    if (offered) throw new Error("Native desktop sent a second offer")
    offered = true
    if (!selectedCodec) throw new Error("Native desktop offered before codec selection")
    const answer = await central.offerPeer(peerId!, sdp, { sessionId: peerId!, sdp, codec: selectedCodec, audio: false })
    if (closed) return
    answered = true
    viewer!.send({ type: "answer", sdp: answer.sdp })
    flushLocal()
    for (const candidate of remoteCandidates.splice(0)) viewer!.send({ type: "candidate", candidate })
    await startCapture()
  }
  function receive(event: ViewerEvent): void {
    if (closed) return
    try {
      switch (event.type) {
        case "capabilities": {
          if (selectedCodec || !startCommand) throw new Error("Unexpected native desktop capabilities")
          selectedCodec = (["av1", "h265", "h264"] as const).find(codec => !excluded.has(codec) && remoteCodecs.includes(codec) && event.codecs.includes(codec))
          if (!selectedCodec) throw new Error("No common native desktop video codec is available")
          viewer!.send({ ...startCommand, codec: selectedCodec })
          break
        }
        case "offer": void offer(event.sdp).catch(fail); break
        case "candidate": localCandidates.push(event.candidate); flushLocal(); break
        case "answerApplied":
          if (!answered) throw new Error("Native desktop applied an unexpected answer")
          answerApplied = true; void startCapture().catch(fail); break
        case "inputReady": inputReady = true; finishStartup(); break
        case "videoReady": videoReady = true; finishStartup(); break
        case "connected":
          connected = true; localDisconnects.update("connected"); void startCapture().catch(fail); break
        case "disconnected": connected = false; localDisconnects.update("disconnected"); break
        case "error": {
          const error = Object.assign(new Error(event.error), event.reason ? { reason: event.reason } : {})
          if (event.reason) fail(error)
          else transportFailed(error)
          break
        }
        case "closeRequested": void close().catch(fail); break
        case "closed":
          if (startPending && startFailure) break
          void close().catch(fail); break
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
      } else if (value.kind === "error") fail(Object.assign(new Error("error" in value ? String(value.error) : "Remote desktop failed"), "reason" in value ? { reason: value.reason } : {}))
      else if (value.kind === "stateChanged" && "state" in value) {
        if (["failed", "closed"].includes(String(value.state).toLowerCase())) transportFailed(new Error("Remote desktop connection closed"))
        else remoteDisconnects.update(String(value.state))
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
    const display = capabilities.displays.find(display => display.id === request.displayId)
    if (!display || !display.codecs.some(codec => !excluded.has(codec))) throw new Error("No common native desktop video codec is available")
    remoteCodecs = display.codecs
    const grant = await central.createPeer(request.target.teamId, machine.id, "desktop")
    peerId = grant.peerId
    if (closed) { closeGrant(); return }
    telemetry = observePeerGrant("desktop", grant, request.target.teamId)
    const expiry = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Desktop authorization has expired")
    expires = setTimeout(() => fail(new Error("Desktop authorization has expired. Reconnect to continue.")), expiry - Date.now())
    startCommand = {
      type: "start", title: machine.name, control: request.control, relayOnly: false,
      width: display.width, height: display.height,
      iceServers: grant.iceServers.map(server => ({
        urls: typeof server.urls === "string" ? [server.urls] : server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
      })),
    }
    viewer = spawn(receive)
    if (closed) { await viewer.close(); return }
  }
  void negotiate().catch(fail)
  return { ready, close, release: closeGrant }
}
