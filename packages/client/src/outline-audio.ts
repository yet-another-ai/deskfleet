export const OUTLINE_SPECTRUM_BINS = 224

export interface OutlineAudioStatus {
  supported: boolean
  active: boolean
}

export interface OutlineAudioSpectrumFrame {
  sampleRate: number
  /** Concatenated [left(224), right(224)] byte dB bins in [-80, -10] dB. */
  bins: Uint8Array
}

/** Host-provided system audio spectrum capture for mobile clients. */
export interface OutlineAudioApi {
  status(): Promise<OutlineAudioStatus>
  /**
   * Resolves true when capture starts, or false if the user cancels the system picker.
   * Rejects with an error whose `code` is `permission-denied` or `unavailable`.
   */
  start(): Promise<boolean>
  stop(): Promise<void>
  onSpectrum(listener: (frame: OutlineAudioSpectrumFrame) => void): () => void
  onStopped(listener: () => void): () => void
}
