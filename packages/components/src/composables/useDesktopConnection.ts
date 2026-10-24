import { onScopeDispose, ref, shallowRef } from "vue"
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
  return (["h264", "h265", "av1"] as const).filter(
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
}

export interface DesktopConnectOptions {
  codec: VideoCodec
  displayId: number
  audio: boolean
}

/** Chromium receives and decodes media; the bridge carries signaling only. */
export function useDesktopConnection(api: DesktopMediaApi) {
  const state = ref<DesktopConnectionState>("idle")
  const failure = shallowRef<DesktopFailure | null>(null)
  const stream = shallowRef<MediaStream | null>(null)
  let current: Session | null = null
  let generation = 0

  function release(session: Session): void {
    clearTimeout(session.timeout)
    session.unsubscribe()
    session.peer.onicecandidate = null
    session.peer.onconnectionstatechange = null
    session.peer.ontrack = null
    session.peer.close()
    for (const track of session.stream.getTracks()) track.stop()
    if (current === session) {
      current = null
      stream.value = null
    }
  }

  function fail(session: Session, reason: DesktopFailure): void {
    if (current !== session) return
    release(session)
    failure.value = reason
    state.value = "error"
    void api.close(session.id).catch(() => {})
  }

  function operationFailed(session: Session, error: unknown): void {
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
        await api.close(session.id)
        return
      }
      clearTimeout(session.timeout)
      state.value = "connected"
    } catch (error) {
      operationFailed(session, error)
    }
  }

  async function connect(options: DesktopConnectOptions): Promise<void> {
    if (current) return
    ++generation
    state.value = "connecting"
    failure.value = null
    let session: Session | null = null
    try {
      const preferences = browserCodecPreferences(
        options.codec, RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
      )
      if (preferences.length === 0) throw new Error("The selected video codec is unavailable.")
      const id = crypto.randomUUID()
      const preparing = generation
      const iceServers = api.prepare ? await api.prepare(id) : []
      if (preparing !== generation) { await api.close(id); return }
      const peer = new RTCPeerConnection({ iceServers })
      session = {
        id, peer, stream: new MediaStream(), unsubscribe: () => {},
        timeout: setTimeout(() => { if (session) fail(session, { kind: "timeout" }) }, 20_000),
        offered: false, remoteReady: false, startRequested: false,
        localCandidates: [], remoteCandidates: [], localSending: Promise.resolve(), remoteAdding: Promise.resolve(),
        start: { sessionId: id, displayId: options.displayId },
      }
      current = session
      stream.value = session.stream
      const active = session
      active.unsubscribe = api.onEvent((event) => {
        if (event.sessionId !== active.id || current !== active) return
        if (event.kind === "iceCandidate") {
          active.remoteCandidates.push(event.candidate)
          addCandidates(active)
        } else if (event.kind === "error") {
          fail(active, { kind: "operation", detail: event.error })
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
      const answer = await api.offer({ sessionId: id, sdp: offer.sdp!, codec: options.codec, audio: options.audio })
      // An offer or capture start may finish after the user has already left.
      if (current !== active) {
        await api.close(id)
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
      if (session) operationFailed(session, error)
      else {
        failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error) }
        state.value = "error"
      }
    }
  }

  async function disconnect(): Promise<void> {
    const closingGeneration = ++generation
    const session = current
    if (session) release(session)
    state.value = "idle"
    failure.value = null
    if (session) {
      try { await api.close(session.id) }
      catch (error) {
        if (generation === closingGeneration && !current && state.value === "idle") {
          failure.value = { kind: "operation", detail: error instanceof Error ? error.message : String(error) }
          state.value = "error"
        }
      }
    }
  }

  onScopeDispose(() => { void disconnect() })
  return { state, failure, stream, connect, disconnect }
}
