import { onScopeDispose, ref, shallowRef } from "vue"
import { DESKTOP_INPUT_CHANNEL, type DesktopInputMessage } from "../../../client/src/desktop-input.ts"
import type {
  DesktopMediaApi,
  DesktopStart,
  IceCandidate,
  VideoCodec,
} from "../../../client/src/desktop-media.ts"

export type DesktopConnectionState = "idle" | "connecting" | "starting" | "connected" | "error"
export interface DesktopFailure {
  kind: "timeout" | "connection" | "operation"
  detail?: string
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
  localCandidates: IceCandidate[]
  remoteCandidates: IceCandidate[]
  localSending: Promise<void>
  remoteAdding: Promise<void>
  start: DesktopStart
  options: DesktopConnectOptions
  replaced: boolean
  input: RTCDataChannel | null
  inputReady: boolean
}

export function desktopCodecLabel(codec: VideoCodec): string {
  if (codec === "h264") return "H.264"
  if (codec === "h265") return "HEVC"
  return "AV1"
}

function isEncoderReason(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { reason?: unknown }).reason === "encoder"
}

export interface DesktopConnectOptions {
  /** Common codecs in preference order. The connection tries the next one only after an encoder failure. */
  codecs: readonly VideoCodec[]
  displayId: number
  audio: boolean
  control?: boolean
}

/** Chromium receives and decodes media; the bridge carries signaling only. */
export function useDesktopConnection(api: DesktopMediaApi) {
  const state = ref<DesktopConnectionState>("idle")
  const failure = shallowRef<DesktopFailure | null>(null)
  const stream = shallowRef<MediaStream | null>(null)
  const codec = ref<VideoCodec | null>(null)
  const inputReady = ref(false)
  let current: Session | null = null
  let generation = 0
  let running = false
  let chain: VideoCodec[] = []
  let closing = Promise.resolve()

  function closePeer(id: string): Promise<void> {
    const closed = api.close(id)
    // Retain every in-flight close, including a late offer from an older generation.
    closing = Promise.allSettled([closing, closed]).then(() => {})
    return closed
  }

  function release(session: Session): void {
    clearTimeout(session.timeout)
    if (session.input) {
      if (session.input.readyState === "open") {
        try { session.input.send(JSON.stringify({ type: "releaseAll" })) } catch { /* Peer closure also releases held input. */ }
      }
      session.input.onmessage = null
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
    chain = []
  }

  function fail(session: Session, reason: DesktopFailure): void {
    if (current !== session || session.replaced) return
    if (reason.kind === "connection" || reason.kind === "timeout") {
      const detail = api.connectionFailure?.(session.id)
      if (detail) reason = { kind: "connection", detail }
    }
    session.replaced = true
    stopChain()
    release(session)
    codec.value = null
    failure.value = reason
    state.value = "error"
    void closePeer(session.id).catch(() => {})
  }

  function continueWithNext(session: Session, detail: string): void {
    if (current !== session || session.replaced) return
    session.replaced = true
    const run = generation
    const options = session.options
    release(session)
    chain.shift()
    state.value = "connecting"
    // The old native peer owns the input controller until close completes.
    // Starting its replacement sooner can contend with that controller.
    void closePeer(session.id).then(() => {
      if (generation !== run || !running) return
      if (!chain[0]) {
        stopChain()
        codec.value = null
        failure.value = { kind: "operation", detail }
        state.value = "error"
        return
      }
      void begin(options, run)
    }).catch((error: unknown) => {
      if (generation !== run || !running) return
      stopChain()
      codec.value = null
      failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error) }
      state.value = "error"
    })
  }

  function operationFailed(session: Session, error: unknown): void {
    if (isEncoderReason(error)) {
      continueWithNext(session, error instanceof Error ? error.message : String(error))
      return
    }
    fail(session, { kind: "operation", detail: error instanceof Error ? error.message : String(error) })
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
    try {
      await api.start(session.start)
      if (current !== session) {
        await closePeer(session.id)
        return
      }
      if (!session.options.control || session.inputReady) clearTimeout(session.timeout)
      state.value = "connected"
      inputReady.value = session.inputReady
    } catch (error) {
      operationFailed(session, error)
    }
  }

  async function begin(options: DesktopConnectOptions, run: number): Promise<void> {
    const selected = chain[0]
    if (!selected || generation !== run) return
    codec.value = selected
    state.value = "connecting"
    failure.value = null
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
      const peer = new RTCPeerConnection({ iceServers })
      session = {
        id, peer, stream: new MediaStream(), unsubscribe: () => {},
        timeout: setTimeout(() => { if (session) fail(session, { kind: "timeout" }) }, 20_000),
        offered: false, remoteReady: false, startRequested: false,
        localCandidates: [], remoteCandidates: [], localSending: Promise.resolve(), remoteAdding: Promise.resolve(),
        start: { sessionId: id, displayId: options.displayId, ...(options.control ? { control: true } : {}) },
        options, replaced: false,
        input: null, inputReady: false,
      }
      current = session
      stream.value = session.stream
      const active = session
      if (options.control) {
        const channel = peer.createDataChannel(DESKTOP_INPUT_CHANNEL, { ordered: true })
        active.input = channel
        channel.onmessage = event => {
          if (current !== active) return
          try {
            const reply: unknown = JSON.parse(String(event.data))
            if (typeof reply !== "object" || reply === null) throw new Error("Invalid desktop input response")
            const message = reply as { type?: unknown; error?: unknown }
            if (message.type === "ready") {
              active.inputReady = true
              inputReady.value = state.value === "connected"
              if (inputReady.value) clearTimeout(active.timeout)
            } else if (message.type === "error" && typeof message.error === "string") {
              fail(active, { kind: "operation", detail: message.error })
            } else {
              throw new Error("Invalid desktop input response")
            }
          } catch (error) { operationFailed(active, error) }
        }
        channel.onclose = () => fail(active, { kind: "operation", detail: "Desktop input channel closed." })
        channel.onerror = () => fail(active, { kind: "operation", detail: "Desktop input channel failed." })
      }
      active.unsubscribe = api.onEvent((event) => {
        if (event.sessionId !== active.id || current !== active) return
        if (event.kind === "iceCandidate") {
          active.remoteCandidates.push(event.candidate)
          addCandidates(active)
        } else if (event.kind === "error") {
          if (event.reason === "encoder") continueWithNext(active, event.error)
          else fail(active, { kind: "operation", detail: event.error })
        } else if (["failed", "closed", "disconnected"].includes(event.state.toLowerCase())) {
          fail(active, { kind: "connection" })
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
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
          fail(active, { kind: "connection" })
        } else {
          void startWhenConnected(active)
        }
      }
      peer.addTransceiver("video", { direction: "recvonly" }).setCodecPreferences(preferences)
      if (options.audio) peer.addTransceiver("audio", { direction: "recvonly" })
      const offer = await peer.createOffer()
      if (current !== active) return
      await peer.setLocalDescription(offer)
      if (current !== active) return
      const answer = await api.offer({ sessionId: id, sdp: offer.sdp!, codec: selected, audio: options.audio })
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
      else if (!session) {
        stopChain()
        codec.value = null
        failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error) }
        state.value = "error"
      }
    }
  }

  async function connect(options: DesktopConnectOptions): Promise<void> {
    if (current || running) return
    const run = ++generation
    running = true
    chain = [...options.codecs]
    failure.value = null
    codec.value = null
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

  async function disconnect(): Promise<void> {
    const closingGeneration = ++generation
    stopChain()
    codec.value = null
    const session = current
    if (session) release(session)
    state.value = "idle"
    failure.value = null
    if (session) {
      try { await closePeer(session.id) }
      catch (error) {
        if (generation === closingGeneration && !current && state.value === "idle") {
          failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error) }
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
  return { state, failure, stream, codec, inputReady, connect, disconnect, sendInput }
}
