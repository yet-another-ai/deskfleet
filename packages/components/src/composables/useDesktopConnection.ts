import { onScopeDispose, ref, shallowRef } from "vue"
import type { RelayDeniedReason } from "../../../client/src/relay.ts"
import { PEER_SETUP_TIMEOUT_MS, createPeerDisconnectGuard, type PeerDisconnectGuard } from "../../../client/src/peer-lifecycle.ts"
import { DESKTOP_INPUT_CHANNEL, type DesktopInputMessage, type DesktopSettingsMessage } from "../../../client/src/desktop-input.ts"
import type {
  DesktopMediaApi,
  DesktopErrorReason,
  DesktopStart,
  IceCandidate,
  VideoCodec,
} from "../../../client/src/desktop-media.ts"
import { DESKTOP_START_TIMEOUT_MS, desktopErrorReason } from "../../../client/src/desktop-media.ts"

export type DesktopConnectionState = "idle" | "connecting" | "starting" | "connected" | "error"
export interface DesktopFailure {
  kind: "timeout" | "connection" | "operation"
  detail?: string
  error?: unknown
  relayDeniedReason?: RelayDeniedReason
  reason?: DesktopErrorReason
}

function parameters(codec: RTCRtpCodec): Map<string, string> {
  return new Map((codec.sdpFmtpLine ?? "").split(";").map((entry) => {
    const [key = "", value = ""] = entry.trim().split("=")
    return [key.toLowerCase(), value.toLowerCase()]
  }))
}

/** Match the native encoder profiles, rather than just the codec's MIME type. */
export function browserCodecPreferences(codec: VideoCodec, codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter((entry) => {
    if (entry.mimeType.toLowerCase() !== `video/${codec}`) return false
    const fmtp = parameters(entry)
    if (codec === "h264") {
      return fmtp.get("packetization-mode") === "1"
        && (fmtp.get("profile-level-id") ?? "42e01f").startsWith("42e0")
    }
    if (codec === "h265") return (fmtp.get("profile-id") ?? "1") === "1"
    return (fmtp.get("profile") ?? "0") === "0"
  })
}

export function commonDesktopCodecs(nativeCodecs: VideoCodec[], browserCodecs: RTCRtpCodec[]): VideoCodec[] {
  return (["av1", "h265", "h264"] as const).filter(
    (codec) => nativeCodecs.includes(codec) && browserCodecPreferences(codec, browserCodecs).length > 0,
  )
}

interface Session {
  id: string
  peer: RTCPeerConnection
  stream: MediaStream
  unsubscribe: () => void
  timeout: ReturnType<typeof setTimeout>
  offered: boolean
  remoteReady: boolean
  startRequested: boolean
  startSettled: boolean
  localCandidates: IceCandidate[]
  remoteCandidates: IceCandidate[]
  localSending: Promise<void>
  remoteAdding: Promise<void>
  start: DesktopStart
  options: DesktopConnectOptions
  replaced: boolean
  input: RTCDataChannel | null
  inputReady: boolean
  startupInputReady: boolean
  inputFailure: DesktopFailure | null
  appliedSettings: LiveSettings | null
  configuring: DesktopSettingsMessage | null
  configurationTimeout: ReturnType<typeof setTimeout> | null
  nextRequestId: number
  disconnects: PeerDisconnectGuard
}

interface LiveSettings { audio: boolean; control: boolean }

/** Native input ownership is acknowledged after media connects; that wait is not NAT latency. */
const INPUT_READY_TIMEOUT_MS = 10_000

export function desktopCodecLabel(codec: VideoCodec): string {
  if (codec === "h264") return "H.264"
  if (codec === "h265") return "HEVC"
  return "AV1"
}

export interface DesktopConnectOptions extends Omit<DesktopStart, "sessionId"> {
  /** Common codecs in preference order. The connection tries the next one only after an encoder failure. */
  codecs: readonly VideoCodec[]
  audio: boolean
  /** Full viewers retain the input channel for changing audio and control in place. */
  liveSettings?: boolean
  /** Negotiate the available audio track even when playback starts disabled. */
  audioAvailable?: boolean
}

/** Chromium receives and decodes media; the bridge carries signaling only. */
export function useDesktopConnection(api: DesktopMediaApi) {
  const state = ref<DesktopConnectionState>("idle")
  const failure = shallowRef<DesktopFailure | null>(null)
  const settingsFailure = shallowRef<DesktopFailure | null>(null)
  const stream = shallowRef<MediaStream | null>(null)
  const codec = ref<VideoCodec | null>(null)
  const inputReady = ref(false)
  let current: Session | null = null
  let generation = 0
  let running = false
  let requestedOptions: DesktopConnectOptions | null = null
  let chain: VideoCodec[] = []
  let closing = Promise.resolve()
  let replacementCleanup: Promise<void> | null = null

  function closePeer(id: string): Promise<void> {
    const closed = api.close(id)
    // Retain every in-flight close, including a late offer from an older generation.
    closing = Promise.allSettled([closing, closed]).then(() => {})
    return closed
  }

  function release(session: Session): void {
    clearTimeout(session.timeout)
    if (session.configurationTimeout) clearTimeout(session.configurationTimeout)
    session.disconnects.clear()
    if (session.input) {
      const mayControl = session.inputReady || session.configuring?.control
        || (session.startRequested && !session.startSettled && session.start.control)
      if (mayControl && session.input.readyState === "open") {
        try { session.input.send(JSON.stringify({ type: "releaseAll" })) } catch { /* Peer closure also releases held input. */ }
      }
      session.input.onmessage = null
      session.input.onopen = null
      session.input.onclose = null
      session.input.onerror = null
      session.input.close()
    }
    session.unsubscribe()
    session.peer.onicecandidate = null
    session.peer.onconnectionstatechange = null
    session.peer.ontrack = null
    session.peer.close()
    for (const track of session.stream.getTracks()) track.stop()
    if (current === session) {
      current = null
      stream.value = null
      inputReady.value = false
    }
  }

  function stopChain(): void {
    running = false
    requestedOptions = null
    replacementCleanup = null
    chain = []
  }

  function fail(session: Session, reason: DesktopFailure): void {
    if (current !== session || session.replaced) return
    if (reason.kind === "connection" || reason.kind === "timeout") {
      const detail = api.connectionFailure?.(session.id)
      const relayDeniedReason = api.connectionFailureReason?.(session.id)
      if (detail || relayDeniedReason) reason = { kind: "connection", ...(detail ? { detail } : {}), ...(relayDeniedReason ? { relayDeniedReason } : {}) }
    }
    session.replaced = true
    stopChain()
    release(session)
    codec.value = null
    failure.value = reason
    state.value = "error"
    void closePeer(session.id).catch(() => {})
  }

  function continueWithNext(session: Session, detail: string, error?: unknown): void {
    if (current !== session || session.replaced) return
    session.replaced = true
    const run = generation
    const options = session.options
    release(session)
    chain.shift()
    state.value = "connecting"
    // The old native peer owns the input controller until close completes.
    // Starting its replacement sooner can contend with that controller.
    replacementCleanup = closePeer(session.id)
    void replacementCleanup.then(() => {
      if (generation !== run || !running) return
      if (!chain[0]) {
        stopChain()
        codec.value = null
        failure.value = { kind: "operation", detail, ...(error === undefined ? {} : { error }) }
        state.value = "error"
        return
      }
      void begin(options, run)
    }).catch((error: unknown) => {
      if (generation !== run || !running) return
      stopChain()
      codec.value = null
      failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error), error }
      state.value = "error"
    })
  }

  function operationFailed(session: Session, error: unknown): void {
    const reason = desktopErrorReason(error)
    if (reason === "encoder") {
      continueWithNext(session, error instanceof Error ? error.message : String(error), error)
      return
    }
    fail(session, { kind: "operation", detail: error instanceof Error ? error.message : String(error), error, ...(reason ? { reason } : {}) })
  }

  function inputChannelFailed(session: Session, detail: string): void {
    const failure: DesktopFailure = { kind: "operation", detail }
    if (!session.startSettled) {
      session.inputFailure ??= failure
      return
    }
    fail(session, failure)
  }

  function settingsRejected(session: Session, reason: DesktopFailure, control: boolean): void {
    const pending = session.configuring
    if (!pending) return
    if (session.configurationTimeout) clearTimeout(session.configurationTimeout)
    session.configurationTimeout = null
    session.configuring = null
    // Audio may have changed before control failed; retry both settings.
    session.appliedSettings = null
    session.inputReady = control && !!session.options.control
    inputReady.value = session.inputReady
    settingsFailure.value = reason
    if (!sameSettings(pending, session.options)) sendSettings(session)
  }

  function sendSettings(session: Session): void {
    if (current !== session || !session.options.liveSettings || !session.startSettled
      || session.input?.readyState !== "open" || session.configuring
      || sameSettings(session.appliedSettings, session.options)) return
    const settings: DesktopSettingsMessage = { type: "configure", audio: session.options.audio, control: !!session.options.control, requestId: ++session.nextRequestId }
    session.configuring = settings
    settingsFailure.value = null
    clearTimeout(session.timeout)
    session.configurationTimeout = setTimeout(() => {
      if (current === session) settingsRejected(session, { kind: "timeout" }, session.inputReady)
    }, INPUT_READY_TIMEOUT_MS)
    try { session.input.send(JSON.stringify(settings)) }
    catch (error) {
      settingsRejected(session, { kind: "operation", detail: error instanceof Error ? error.message : String(error), error }, session.inputReady)
    }
  }

  function sendCandidates(session: Session): void {
    if (!session.offered || current !== session) return
    const candidates = session.localCandidates.splice(0)
    session.localSending = session.localSending.then(async () => {
      for (const candidate of candidates) {
        if (current !== session) return
        await api.candidate(session.id, candidate)
      }
    }).catch((error: unknown) => operationFailed(session, error))
  }

  function addCandidates(session: Session): void {
    if (!session.remoteReady || current !== session) return
    const candidates = session.remoteCandidates.splice(0)
    session.remoteAdding = session.remoteAdding.then(async () => {
      for (const candidate of candidates) {
        if (current !== session) return
        await session.peer.addIceCandidate({
          candidate: candidate.candidate,
          ...(candidate.sdpMid != null ? { sdpMid: candidate.sdpMid } : {}),
          ...(candidate.sdpMlineIndex != null ? { sdpMLineIndex: candidate.sdpMlineIndex } : {}),
          ...(candidate.usernameFragment != null ? { usernameFragment: candidate.usernameFragment } : {}),
        })
      }
    }).catch((error: unknown) => operationFailed(session, error))
  }

  async function startWhenConnected(session: Session): Promise<void> {
    if (current !== session || !session.remoteReady || session.startRequested
      || session.peer.connectionState !== "connected") return
    session.startRequested = true
    state.value = "starting"
    // Capture gets its full startup budget after SDP and ICE have completed.
    clearTimeout(session.timeout)
    session.timeout = setTimeout(() => fail(session, { kind: "timeout" }), DESKTOP_START_TIMEOUT_MS)
    try {
      await api.start(session.start)
      session.startSettled = true
      if (current !== session) {
        await closePeer(session.id)
        return
      }
      if (session.inputFailure) {
        fail(session, session.inputFailure)
        return
      }
      clearTimeout(session.timeout)
      session.inputReady = session.startupInputReady && !!session.options.control
      session.appliedSettings = { audio: session.options.audioAvailable ?? session.options.audio, control: !!session.start.control }
      if (session.options.control && !session.inputReady) {
        session.timeout = setTimeout(() => { if (session) fail(session, { kind: "timeout" }) }, INPUT_READY_TIMEOUT_MS)
      }
      state.value = "connected"
      inputReady.value = session.inputReady
      sendSettings(session)
    } catch (error) {
      session.startSettled = true
      operationFailed(session, error)
    }
  }

  async function begin(options: DesktopConnectOptions, run: number): Promise<void> {
    const selected = chain[0]
    if (!selected || generation !== run) return
    codec.value = selected
    state.value = "connecting"
    failure.value = null
    settingsFailure.value = null
    let session: Session | null = null
    try {
      const preferences = browserCodecPreferences(
        selected, RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
      )
      if (preferences.length === 0) throw new Error("The selected video codec is unavailable.")
      const id = crypto.randomUUID()
      const preparing = generation
      const iceServers = api.prepare ? await api.prepare(id) : []
      if (preparing !== generation) { await closePeer(id); return }
      options = requestedOptions ?? options
      const peer = new RTCPeerConnection({ iceServers })
      session = {
        id, peer, stream: new MediaStream(), unsubscribe: () => {},
        timeout: setTimeout(() => { if (session) fail(session, { kind: "timeout" }) }, PEER_SETUP_TIMEOUT_MS),
        offered: false, remoteReady: false, startRequested: false, startSettled: false,
        localCandidates: [], remoteCandidates: [], localSending: Promise.resolve(), remoteAdding: Promise.resolve(),
        start: {
          sessionId: id, displayId: options.displayId,
          ...(options.control ? { control: true } : {}),
          ...(options.fps === undefined ? {} : { fps: options.fps }),
          ...(options.bitrateBps === undefined ? {} : { bitrateBps: options.bitrateBps }),
          ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
          ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
        },
        options, replaced: false,
        input: null, inputReady: false, startupInputReady: false, inputFailure: null,
        appliedSettings: null, configuring: null, configurationTimeout: null, nextRequestId: 0,
        disconnects: createPeerDisconnectGuard(() => { if (session) fail(session, { kind: "connection", detail: "Desktop connection lost" }) }),
      }
      current = session
      stream.value = session.stream
      const active = session
      if (options.control || options.liveSettings) {
        const channel = peer.createDataChannel(DESKTOP_INPUT_CHANNEL, { ordered: true })
        active.input = channel
        channel.onmessage = event => {
          if (current !== active) return
          try {
            const reply: unknown = JSON.parse(String(event.data))
            if (typeof reply !== "object" || reply === null) throw new Error("Invalid desktop input response")
            const message = reply as { type?: unknown; error?: unknown; requestId?: unknown; control?: unknown }
            if (message.type === "ready") {
              active.startupInputReady = true
              if (!active.options.control || active.configuring) return
              active.inputReady = true
              inputReady.value = state.value === "connected"
              if (inputReady.value) clearTimeout(active.timeout)
            } else if (message.type === "configured" || message.type === "configurationError") {
              if (message.requestId !== active.configuring?.requestId) return
              if (typeof message.control !== "boolean") throw new Error("Invalid desktop configuration response")
              if (message.type === "configurationError") {
                if (typeof message.error !== "string") throw new Error("Invalid desktop configuration response")
                const reason = desktopErrorReason(message)
                settingsRejected(active, { kind: "operation", detail: message.error, ...(reason ? { reason } : {}) }, message.control)
              } else {
                if (active.configurationTimeout) clearTimeout(active.configurationTimeout)
                active.configurationTimeout = null
                active.appliedSettings = { audio: active.configuring!.audio, control: message.control }
                active.configuring = null
                active.inputReady = message.control && !!active.options.control
                inputReady.value = active.inputReady
                settingsFailure.value = null
                sendSettings(active)
              }
            } else if (message.type === "error" && typeof message.error === "string") {
              operationFailed(active, message.error)
            } else {
              throw new Error("Invalid desktop input response")
            }
          } catch (error) { operationFailed(active, error) }
        }
        channel.onopen = () => sendSettings(active)
        channel.onclose = () => inputChannelFailed(active, "Desktop input channel closed.")
        channel.onerror = () => inputChannelFailed(active, "Desktop input channel failed.")
      }
      active.unsubscribe = api.onEvent((event) => {
        if (event.sessionId !== active.id || current !== active) return
        if (event.kind === "iceCandidate") {
          active.remoteCandidates.push(event.candidate)
          addCandidates(active)
        } else if (event.kind === "error") {
          if (event.reason === "encoder") continueWithNext(active, event.error)
          else {
            const reason = event.reason ?? desktopErrorReason(event.error)
            fail(active, { kind: "operation", detail: event.error, ...(reason ? { reason } : {}) })
          }
        } else if (["failed", "closed"].includes(event.state.toLowerCase())) {
          fail(active, { kind: "connection" })
        } else {
          active.disconnects.update(event.state)
          if (event.state.toLowerCase() === "connected") void startWhenConnected(active)
        }
      })
      peer.onicecandidate = ({ candidate }) => {
        if (!candidate || current !== active) return
        const json = candidate.toJSON()
        active.localCandidates.push({
          candidate: json.candidate ?? "",
          ...(json.sdpMid != null ? { sdpMid: json.sdpMid } : {}),
          ...(json.sdpMLineIndex != null ? { sdpMlineIndex: json.sdpMLineIndex } : {}),
          ...(json.usernameFragment != null ? { usernameFragment: json.usernameFragment } : {}),
        })
        sendCandidates(active)
      }
      peer.ontrack = ({ track }) => {
        if (current === active) active.stream.addTrack(track)
      }
      peer.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(peer.connectionState)) {
          fail(active, { kind: "connection" })
        } else {
          active.disconnects.update(peer.connectionState)
          void startWhenConnected(active)
        }
      }
      peer.addTransceiver("video", { direction: "recvonly" }).setCodecPreferences(preferences)
      const negotiateAudio = options.audioAvailable ?? options.audio
      if (negotiateAudio) peer.addTransceiver("audio", { direction: "recvonly" })
      const offer = await peer.createOffer()
      if (current !== active) return
      await peer.setLocalDescription(offer)
      if (current !== active) return
      const answer = await api.offer({ sessionId: id, sdp: offer.sdp!, codec: selected, audio: negotiateAudio })
      // An offer or capture start may finish after the user has already left.
      if (current !== active) {
        await closePeer(id)
        return
      }
      active.offered = true
      sendCandidates(active)
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp })
      if (current !== active) return
      active.remoteReady = true
      addCandidates(active)
      await startWhenConnected(active)
    } catch (error) {
      if (session && !session.replaced) operationFailed(session, error)
      else if (!session && generation === run && running) {
        stopChain()
        codec.value = null
        failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error), error }
        state.value = "error"
      }
    }
  }

  async function configure(options: DesktopConnectOptions, replace: boolean): Promise<void> {
    if (replace) {
      if (!running || (sameOptions(requestedOptions, options) && !settingsFailure.value)) return
      if (options.liveSettings && requestedOptions?.liveSettings && sameTransportOptions(requestedOptions, options)) {
        requestedOptions = { ...options, codecs: [...options.codecs] }
        settingsFailure.value = null
        const session = current
        if (session) {
          session.options = requestedOptions
          if (!options.control) {
            sendInput({ type: "releaseAll" })
            session.inputReady = false
            inputReady.value = false
          }
          sendSettings(session)
        }
        return
      }
    } else if (current || running) return
    const run = ++generation
    running = true
    requestedOptions = { ...options, codecs: [...options.codecs] }
    chain = [...options.codecs]
    failure.value = null
    settingsFailure.value = null
    codec.value = null
    // Keep the viewer active (and fullscreen) while releasing the old peer.
    state.value = "connecting"
    const session = current
    if (session) {
      session.replaced = true
      release(session)
      replacementCleanup = closePeer(session.id)
    }
    if (replacementCleanup) {
      // A newer settings request must inherit cleanup failure as well as its
      // wait; an all-settled barrier alone could leave native input owned.
      try { await replacementCleanup }
      catch (error) {
        if (generation !== run || !running) return
        stopChain()
        failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error), error }
        state.value = "error"
        return
      }
      if (generation !== run || !running) return
    }
    if (chain.length === 0) {
      stopChain()
      failure.value = { kind: "operation", detail: "The selected video codec is unavailable." }
      state.value = "error"
      return
    }
    for (;;) {
      const pending = closing
      await pending
      if (generation !== run || !running) return
      if (pending === closing) break
    }
    await begin(options, run)
  }

  function connect(options: DesktopConnectOptions): Promise<void> {
    return configure(options, false)
  }

  /** Audio and control update in place; capture changes negotiate a replacement peer. */
  function reconfigure(options: DesktopConnectOptions): Promise<void> {
    return configure(options, true)
  }

  async function disconnect(): Promise<void> {
    const closingGeneration = ++generation
    stopChain()
    codec.value = null
    const session = current
    if (session) release(session)
    state.value = "idle"
    failure.value = null
    settingsFailure.value = null
    if (session) {
      try { await closePeer(session.id) }
      catch (error) {
        if (generation === closingGeneration && !current && state.value === "idle") {
          failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error), error }
          state.value = "error"
        }
      }
    }
  }

  function sendInput(message: DesktopInputMessage): boolean {
    const session = current
    if (!session?.input || !session.inputReady || session.input.readyState !== "open") return false
    try {
      // A saturated reliable channel must close rather than strand a key-up behind unbounded moves.
      if (session.input.bufferedAmount > 64 * 1024) throw new Error("Desktop input could not keep up. Reconnect to continue.")
      session.input.send(JSON.stringify(message))
      return true
    } catch (error) {
      operationFailed(session, error)
      return false
    }
  }

  onScopeDispose(() => { void disconnect() })
  return { state, failure, settingsFailure, stream, codec, inputReady, connect, reconfigure, disconnect, sendInput }
}

function sameTransportOptions(current: DesktopConnectOptions | null, next: DesktopConnectOptions): boolean {
  return current !== null && current.displayId === next.displayId && current.fps === next.fps
    && current.bitrateBps === next.bitrateBps && current.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight
    && !!current.liveSettings === !!next.liveSettings && (current.audioAvailable ?? current.audio) === (next.audioAvailable ?? next.audio)
    && current.codecs.length === next.codecs.length && current.codecs.every((codec, index) => codec === next.codecs[index])
}

function sameSettings(current: LiveSettings | null, next: Pick<DesktopConnectOptions, "audio" | "control">): boolean {
  return current !== null && current.audio === next.audio && current.control === !!next.control
}

function sameOptions(current: DesktopConnectOptions | null, next: DesktopConnectOptions): boolean {
  return sameTransportOptions(current, next) && current !== null && sameSettings({ audio: current.audio, control: !!current.control }, next)
}
