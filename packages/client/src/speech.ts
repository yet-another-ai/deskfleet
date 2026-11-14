/** Dictation uses the microphone and speech service on the device displaying the UI. */
export interface SpeechStatus {
  supported: boolean
}

export interface SpeechRequest {
  sessionId: string
  locale: string
}

export type SpeechEvent = { sessionId: string } & (
  | { type: "started" }
  /** Complete transcript for this dictation, replacing the previous result. */
  | { type: "result"; text: string; final: boolean }
  /** Normalized microphone level in [0, 1]. */
  | { type: "level"; level: number }
  | { type: "error"; code: "permission-denied" | "unavailable" | "no-speech" | "network" | "failed"; message?: string }
  | { type: "ended" }
)

export interface SpeechApi {
  /** Does not request microphone or speech recognition permission. */
  status(locale: string): Promise<SpeechStatus>
  start(request: SpeechRequest): Promise<void>
  /** Stop capturing and deliver the final transcript before `ended`. */
  stop(sessionId: string): Promise<void>
  /** Discard pending recognition. */
  cancel(sessionId: string): Promise<void>
  onEvent(listener: (event: SpeechEvent) => void): () => void
}

export const SPEECH_CHANNEL = "deskfleet:speech"
export const SPEECH_EVENT = "deskfleet:speech-event"
