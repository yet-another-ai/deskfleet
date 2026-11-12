import type { SpeechApi, SpeechEvent, SpeechRequest } from "./speech.ts"

interface RecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
}

/** Chromium embedders (including Electron) do not inherit Chrome's speech service. */
export function isChromeSpeechBrowser(userAgent: string, vendor: string): boolean {
  return vendor === "Google Inc." && /\bChrome\/\d+/.test(userAgent)
    && !/\b(?:Electron|Edg|EdgA|OPR|Vivaldi|SamsungBrowser)\//.test(userAgent)
}

function failureCode(reason: string): Extract<SpeechEvent, { type: "error" }>["code"] {
  if (["not-allowed", "service-not-allowed", "NotAllowedError", "SecurityError"].includes(reason)) return "permission-denied"
  if (reason === "no-speech") return "no-speech"
  if (reason === "network") return "network"
  if (["audio-capture", "language-not-supported", "NotFoundError", "NotSupportedError"].includes(reason)) return "unavailable"
  return "failed"
}

interface Session {
  request: SpeechRequest
  recognition?: Recognition
  stream?: MediaStream
  context?: AudioContext
  frame?: number
  finalText: string
  stopping: boolean
}

/** Browser service with explicit Chrome gating and microphone-driven level events. */
export function createBrowserSpeechApi(): SpeechApi | undefined {
  if (typeof window === "undefined" || !window.isSecureContext
    || !isChromeSpeechBrowser(navigator.userAgent, navigator.vendor)) return undefined
  const speechWindow = window as SpeechWindow
  const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
  if (!Recognition || !navigator.mediaDevices?.getUserMedia) return undefined

  const listeners = new Set<(event: SpeechEvent) => void>()
  let active: Session | undefined
  const emit = (session: Session, event: SpeechEvent) => {
    if (active === session) for (const listener of listeners) listener(event)
  }
  function releaseCapture(session: Session): void {
    if (session.frame !== undefined) cancelAnimationFrame(session.frame)
    session.stream?.getTracks().forEach(track => track.stop())
    if (session.context) void session.context.close().catch(() => {})
    session.frame = undefined
    session.stream = undefined
    session.context = undefined
  }
  function release(session: Session): void {
    releaseCapture(session)
    if (session.recognition) {
      session.recognition.onstart = null
      session.recognition.onresult = null
      session.recognition.onerror = null
      session.recognition.onend = null
    }
  }
  function finish(session: Session): void {
    if (active !== session) return
    release(session)
    // Clear ownership before notifying listeners, which may immediately start another dictation.
    active = undefined
    for (const listener of listeners) listener({ sessionId: session.request.sessionId, type: "ended" })
  }
  function meter(session: Session): void {
    if (typeof AudioContext === "undefined" || !session.stream) return
    const context = new AudioContext()
    session.context = context
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    context.createMediaStreamSource(session.stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let previous = 0
    const tick = (now: number) => {
      if (active !== session) return
      if (now - previous >= 50) {
        previous = now
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        emit(session, { sessionId: session.request.sessionId, type: "level", level: Math.min(1, Math.sqrt(sum / samples.length) * 5) })
      }
      if (active === session && !session.stopping) session.frame = requestAnimationFrame(tick)
    }
    session.frame = requestAnimationFrame(tick)
    void context.resume().catch(() => {})
  }

  return {
    status: async () => ({ supported: true }),
    async start(request) {
      if (active) throw new Error("Speech recognition is already active")
      const session: Session = { request, finalText: "", stopping: false }
      active = session
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (active !== session || session.stopping) {
          stream.getTracks().forEach(track => track.stop())
          finish(session)
          return
        }
        session.stream = stream
        const recognition = new Recognition()
        session.recognition = recognition
        recognition.lang = request.locale
        recognition.continuous = true
        recognition.interimResults = true
        recognition.onstart = () => emit(session, { sessionId: request.sessionId, type: "started" })
        recognition.onresult = event => {
          let finalText = ""
          let interimText = ""
          for (const result of Array.from(event.results)) {
            if (result.isFinal) finalText += result[0].transcript
            else interimText += result[0].transcript
          }
          if (finalText !== session.finalText) {
            session.finalText = finalText
            emit(session, { sessionId: request.sessionId, type: "result", text: finalText, final: true })
          }
          if (interimText) emit(session, { sessionId: request.sessionId, type: "result", text: finalText + interimText, final: false })
        }
        recognition.onerror = event => {
          emit(session, { sessionId: request.sessionId, type: "error", code: failureCode(event.error) })
          finish(session)
          recognition.abort()
        }
        recognition.onend = () => finish(session)
        meter(session)
        recognition.start()
      } catch (error) {
        emit(session, { sessionId: request.sessionId, type: "error", code: failureCode(error instanceof Error ? error.name : "failed") })
        finish(session)
      }
    },
    async stop(sessionId) {
      if (active?.request.sessionId !== sessionId) return
      active.stopping = true
      releaseCapture(active)
      active.recognition?.stop()
    },
    async cancel(sessionId) {
      const session = active
      if (!session || session.request.sessionId !== sessionId) return
      const recognition = session.recognition
      finish(session)
      recognition?.abort()
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
