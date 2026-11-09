import type { CentralApi } from "./central.ts"
import { DESKTOP_START_TIMEOUT_MS, type DesktopCapabilities, type IceCandidate, type VideoCodec } from "./desktop-media.ts"
import type { NativeDesktopRequest } from "./native-desktop.ts"
import type { ViewerEvent, ViewerProcess, ViewerUiState } from "./native-desktop-session.ts"
import { createPeerDisconnectGuard, PEER_SETUP_TIMEOUT_MS } from "./peer-lifecycle.ts"
import { observePeerGrant, type PeerConnectionTelemetry } from "./peer-telemetry.ts"

/** One peer lifetime; the outer session owns the window and ordered replacement. */
export function openNativeDesktopAttempt(
  central: CentralApi,
  request: NativeDesktopRequest,
  viewer: ViewerProcess,
  viewerCodecs: VideoCodec[],
  excluded: Set<VideoCodec>,
  update: (state: Partial<ViewerUiState>) => void,
  failed: (error: Error & { codec?: VideoCodec; reason?: string }) => void,
): { ready: Promise<void>; receive(event: ViewerEvent): void; setControl(control: boolean): void; canSelectDisplay(displayId: number): boolean; cancel(): void; release(): Promise<void> } {
  let peerId: string | undefined
  let telemetry: PeerConnectionTelemetry | undefined
  let closed = false, offered = false, connected = false, answered = false, answerApplied = false, starting = false, started = false
  let remoteDisconnected = false
  let grantClosing: Promise<void> | undefined
  let inputReady = false
  let startupInputReady = !request.control
  let control = request.control
  let appliedControl = request.control
  let configuring: boolean | undefined
  let configurationFailed = false
  let displays: DesktopCapabilities["displays"] = []
  let videoReady = false
  let readyResolved = false
  let startPending = false
  let startFailure: Error | undefined
  let selectedCodec: VideoCodec | undefined
  let pendingGrant: Promise<void> | undefined
  let localSending = Promise.resolve()
  let expires: ReturnType<typeof setTimeout> | undefined
  let inputTimeout: ReturnType<typeof setTimeout> | undefined
  const localDisconnects = createPeerDisconnectGuard(() => transportFailed(new Error("Native desktop connection lost")))
  const remoteDisconnects = createPeerDisconnectGuard(() => transportFailed(new Error("Remote desktop connection lost")))
  const localCandidates: IceCandidate[] = [], remoteCandidates: IceCandidate[] = []
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  let startup = setTimeout(() => fail(new Error("Native desktop connection timed out")), PEER_SETUP_TIMEOUT_MS)

  function closeGrant(): Promise<void> {
    if (!peerId) return Promise.resolve()
    if (grantClosing) return grantClosing
    grantClosing = central.closePeer(peerId).catch(error => {
      grantClosing = undefined
      throw error
    })
    return grantClosing
  }
  function cancel(): void {
    if (closed) return
    closed = true
    clearTimeout(startup); clearTimeout(expires); clearTimeout(inputTimeout); unsubscribe()
    localDisconnects.clear(); remoteDisconnects.clear()
    rejectReady(new Error("Native desktop window closed"))
  }
  async function release(): Promise<void> {
    // Grant creation may finish after a display switch or cancellation. Wait for
    // that identity before allowing another attempt to authorize capture.
    await pendingGrant?.catch(() => {})
    await closeGrant()
  }
  function fail(value: unknown): void {
    if (closed) return
    const error = value instanceof Error ? value : new Error(String(value))
    if (selectedCodec && "reason" in error && ["encoder", "decoder"].includes(String(error.reason))) Object.assign(error, { codec: selectedCodec })
    telemetry?.failed()
    rejectReady(error)
    cancel()
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
    update({ status: "starting" })
    if (closed) return
    // Give capture its full startup budget after grant, SDP, and ICE complete.
    clearTimeout(startup)
    startup = setTimeout(() => fail(new Error("Native desktop media startup timed out")), DESKTOP_START_TIMEOUT_MS)
    try {
      await central.startPeer(peerId!, { displayId: request.displayId, ...(request.control ? { control: true } : {}) })
    } finally { startPending = false }
    if (closed) return
    if (startFailure) throw startFailure
    started = true
    sendSettings()
    finishStartup()
    if (!startupInputReady) inputTimeout = setTimeout(() => fail(new Error("Native desktop input readiness timed out")), 10_000)
  }
  function finishStartup(): void {
    if (started && connected && !remoteDisconnected && startupInputReady && videoReady && !closed && !readyResolved) {
      readyResolved = true
      telemetry?.connected()
      clearTimeout(startup)
      clearTimeout(inputTimeout)
      update({ status: "connected", inputReady: control && inputReady })
      resolveReady()
    }
  }
  function updateConnection(): void {
    if (!readyResolved) return
    const active = connected && !remoteDisconnected
    update({ status: active ? "connected" : "connecting", inputReady: active && control && inputReady })
  }
  function setControl(enabled: boolean): void {
    if (closed) return
    control = enabled
    update({ control, inputReady: control && inputReady && connected && !remoteDisconnected, settingsError: undefined })
    sendSettings()
  }
  function sendSettings(): void {
    if (closed || !started || !connected || configuring !== undefined || (control === appliedControl && !configurationFailed)) return
    configuring = control
    configurationFailed = false
    update({ settingsError: undefined })
    viewer.send({ type: "setControl", control })
  }
  function canSelectDisplay(displayId: number): boolean {
    return displays.some(display => display.id === displayId && display.codecs.some(codec => viewerCodecs.includes(codec)))
  }
  async function offer(sdp: string): Promise<void> {
    if (offered) throw new Error("Native desktop sent a second offer")
    offered = true
    if (!selectedCodec) throw new Error("Native desktop offered before codec selection")
    const answer = await central.offerPeer(peerId!, sdp, { codec: selectedCodec, audio: false })
    if (closed) return
    answered = true
    viewer.send({ type: "answer", sdp: answer.sdp })
    flushLocal()
    for (const candidate of remoteCandidates.splice(0)) viewer.send({ type: "candidate", candidate })
    await startCapture()
  }
  function receive(event: ViewerEvent): void {
    if (closed) return
    try {
      switch (event.type) {
        case "offer": void offer(event.sdp).catch(fail); break
        case "candidate": localCandidates.push(event.candidate); flushLocal(); break
        case "answerApplied":
          if (!answered) throw new Error("Native desktop applied an unexpected answer")
          answerApplied = true; void startCapture().catch(fail); break
        case "inputReady":
          startupInputReady = true; inputReady = appliedControl
          update({ inputReady: control && inputReady && connected && !remoteDisconnected }); finishStartup(); break
        case "controlConfigured": {
          if (configuring === undefined) break
          const requested = configuring
          configuring = undefined
          appliedControl = event.control
          inputReady = event.control
          startupInputReady = true
          configurationFailed = event.error !== undefined
          update({ inputReady: control && inputReady && connected && !remoteDisconnected, settingsError: event.error })
          finishStartup()
          if (control !== requested) sendSettings()
          break
        }
        case "videoReady": videoReady = true; finishStartup(); break
        case "connected":
          connected = true; localDisconnects.update("connected")
          finishStartup(); updateConnection(); sendSettings(); void startCapture().catch(fail); break
        case "disconnected": connected = false; localDisconnects.update("disconnected"); updateConnection(); break
        case "error": {
          const error = Object.assign(new Error(event.error), event.reason ? { reason: event.reason } : {})
          if (event.reason) fail(error)
          else transportFailed(error)
          break
        }
        case "stats": break
      }
    } catch (error) { fail(error) }
  }
  const unsubscribe = central.onEvent(event => {
    if ((event.type !== "peerEvent" && event.type !== "peerRevoked") || event.peerId !== peerId || closed) return
    if (event.type === "peerRevoked") { fail(new Error(event.reason)); return }
    const value = event.event
    try {
      if (value.kind === "iceCandidate" && "candidate" in value) {
        const candidate = value.candidate as IceCandidate
        if (answered) viewer.send({ type: "candidate", candidate })
        else remoteCandidates.push(candidate)
      } else if (value.kind === "error") fail(Object.assign(new Error("error" in value ? String(value.error) : "Remote desktop failed"), "reason" in value ? { reason: value.reason } : {}))
      else if (value.kind === "stateChanged" && "state" in value) {
        if (["failed", "closed"].includes(String(value.state).toLowerCase())) transportFailed(new Error("Remote desktop connection closed"))
        else {
          remoteDisconnected = String(value.state).toLowerCase() === "disconnected"
          remoteDisconnects.update(String(value.state))
          finishStartup(); updateConnection()
        }
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
    displays = capabilities.displays
    const display = capabilities.displays.find(display => display.id === request.displayId)
    update({
      title: machine.name,
      displays: capabilities.displays.map(({ id, width, height }) => ({ id, width, height })),
      secureAttention: machine.capabilities?.platform === "win32" && capabilities.secureAttention === true,
    })
    selectedCodec = (["av1", "h265", "h264"] as const).find(codec => !excluded.has(codec) && display?.codecs.includes(codec) && viewerCodecs.includes(codec))
    if (!selectedCodec || !display) throw new Error("No common native desktop video codec is available")
    update({ codec: selectedCodec })
    if (closed) return
    const creating = central.createPeer(request.target.teamId, machine.id, "desktop")
    pendingGrant = creating.then(grant => { peerId = grant.peerId }, () => {})
    const grant = await creating
    if (closed) return
    telemetry = observePeerGrant("desktop", grant, request.target.teamId)
    const expiry = Date.parse(grant.authorization.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Desktop authorization has expired")
    expires = setTimeout(() => fail(new Error("Desktop authorization has expired. Reconnect to continue.")), expiry - Date.now())
    viewer.send({
      type: "start", title: machine.name, codec: selectedCodec, control: request.control, relayOnly: false,
      width: display.width, height: display.height,
      iceServers: grant.iceServers.map(server => ({
        urls: typeof server.urls === "string" ? [server.urls] : server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
      })),
    })
  }
  void negotiate().catch(fail)
  return { ready, receive, setControl, canSelectDisplay, cancel, release }
}
