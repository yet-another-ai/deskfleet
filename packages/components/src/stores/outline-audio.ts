import { OUTLINE_SPECTRUM_BINS, type OutlineAudioApi } from "@deskfleet/client/outline-audio"
import { getClient } from "@deskfleet/client/platform"
import { fittedOklch } from "@proj-airi/chromatic"
import { useEventListener, useRafFn } from "@vueuse/core"
import { defineStore, type Pinia } from "pinia"
import {
  computed,
  hasInjectionContext,
  inject,
  onScopeDispose,
  ref,
  shallowRef,
  triggerRef,
  watch,
  type InjectionKey,
} from "vue"
import { i18n } from "../i18n/index.ts"
import { useAppearanceStore } from "./appearance.ts"

const BAND_COUNT = 24
const STEREO_BANDS = BAND_COUNT * 2
const FFT_SIZE = 4096
const SMOOTHING = 0.2
export const OUTLINE_MIN_WIDTH = 6
const MIN_HZ = 80
const MAX_HZ = 2_400
const MIN_DB = -80
const MAX_DB = -10
const TILT_DB_PER_OCT = 1.8
const SIGNAL_THRESHOLD = 0.02
const STEVENS_EXPONENT = 0.65

const AMP_LUT = Float32Array.from({ length: 256 }, (_, byte) =>
  byte === 0 ? 0 : 10 ** (((byte / 255) * (MAX_DB - MIN_DB) + MIN_DB - MAX_DB) / 20),
)

export function computeChannelBands(bins: Uint8Array, sampleRate: number, channel: 0 | 1, output: Float32Array): void {
  if (bins.length < 2 || sampleRate <= 0) return
  const maxBin = bins.length - 1
  const binScale = FFT_SIZE / sampleRate
  const ratio = Math.min(MAX_HZ, sampleRate * 0.45) / MIN_HZ
  if (ratio <= 1) return

  for (let band = 0; band < BAND_COUNT; band++) {
    const f0 = MIN_HZ * ratio ** (band / BAND_COUNT)
    const fc = MIN_HZ * ratio ** ((band + 0.5) / BAND_COUNT)
    const f1 = MIN_HZ * ratio ** ((band + 1) / BAND_COUNT)
    const startBin = Math.max(1, Math.ceil(f0 * binScale))
    const endBin = Math.min(maxBin, Math.floor(f1 * binScale))
    const pos = Math.min(maxBin, Math.max(1, fc * binScale))
    const lo = Math.floor(pos)
    const frac = pos - lo
    let peak = AMP_LUT[bins[lo] ?? 0]! * (1 - frac) + AMP_LUT[bins[Math.min(maxBin, lo + 1)] ?? 0]! * frac
    let sumSq = peak * peak
    let count = 1

    for (let bin = startBin; bin <= endBin; bin++) {
      const amp = AMP_LUT[bins[bin] ?? 0]!
      if (amp > peak) peak = amp
      sumSq += amp * amp
      count++
    }

    const amplitude = peak * 0.4 + Math.sqrt(sumSq / count) * 0.6
    const tilt = (fc / MIN_HZ) ** (TILT_DB_PER_OCT / 6.0206)
    const perceived = Math.min(1, (amplitude * tilt) ** STEVENS_EXPONENT)
    const slot = channel === 0 ? BAND_COUNT - 1 - band : BAND_COUNT + band
    output[slot] = perceived < SIGNAL_THRESHOLD ? 0 : perceived
  }
}

function demoBandTarget(slot: number, now: number): number {
  const ch = slot < BAND_COUNT ? 0 : 1
  const band = ch === 0 ? BAND_COUNT - 1 - slot : slot - BAND_COUNT
  const u = band / (BAND_COUNT - 1)
  const t = now * 0.001
  const phase = ch * 1.15
  const beat = t * 1.9
  const kickPhase = beat % 1
  const kick = (kickPhase < 0.18 ? Math.sin((kickPhase / 0.18) * Math.PI) : 0) * Math.exp(-u * u * 5.2)

  const eighthPhase = (beat * 2 + ch * 0.16) % 1
  const eighthEnv = eighthPhase < 0.3 ? Math.sin((eighthPhase / 0.3) * Math.PI) : 0
  const ripple = Math.max(0, Math.sin(u * 5.4 - t * 6.2 + phase) * 0.62 + Math.sin(u * 9.2 - t * 3.6 - phase) * 0.38)
  const mids = ripple * (0.22 + 0.78 * eighthEnv) * Math.sin(u * Math.PI) * 0.92

  const hatPhase = ((beat + 0.5 + ch * 0.25) * 2) % 1
  const hatEnv = hatPhase < 0.22 ? Math.sin((hatPhase / 0.22) * Math.PI) : 0
  const shimmer = (0.5 + 0.5 * Math.sin(u * 11 + t * 8.5 + phase)) * hatEnv * (u ** 1.25) * 0.68

  return Math.min(1, (kick + mids + shimmer) * (0.84 + 0.16 * Math.sin(t * 1.3 + phase * 0.5)))
}

function canUseDisplayAudioCapture(): boolean {
  return typeof AudioContext !== "undefined"
    && typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getDisplayMedia === "function"
}

function formatOutlineAudioError(reason: unknown): string {
  if (reason instanceof DOMException && (reason.name === "NotSupportedError" || reason.name === "NotFoundError")) {
    return i18n.global.t("appearance.outlineAudioUnsupported")
  }
  const code = (reason as { code?: unknown } | null | undefined)?.code
  if (code === "permission-denied") return i18n.global.t("appearance.outlineAudioPermissionDenied")
  if (code === "unavailable") return i18n.global.t("appearance.outlineAudioUnavailable")
  return reason instanceof Error ? reason.message : String(reason)
}

function isUserCancellation(reason: unknown): boolean {
  return reason instanceof DOMException && (reason.name === "NotAllowedError" || reason.name === "AbortError")
}

const defineOutlineAudioStore = defineStore("outline-audio", () => {
  const host = getClient()
  const nativeApi = host.outlineAudio
  const isDesktopLoopback = host.platform !== "web"
  const appearance = useAppearanceStore()

  const supported = ref(nativeApi ? true : canUseDisplayAudioCapture())
  const starting = ref(false)
  const error = ref<string | null>(null)
  const decayOverride = ref<number>()
  const decayMs = computed(() => decayOverride.value ?? appearance.settings.outlineAudioDecayMs)
  const previewCount = ref(0)
  const bands = shallowRef(new Float32Array(STEREO_BANDS))
  const activity = ref(0)
  const hue = ref(220)

  const raw = new Float32Array(STEREO_BANDS)
  const targets = new Float32Array(STEREO_BANDS)
  const bins = new Uint8Array(OUTLINE_SPECTRUM_BINS)
  let runningPeak = 0.3
  let prevTime = 0
  let context: AudioContext | undefined
  let analysers: [AnalyserNode, AnalyserNode] | undefined
  let releaseCaptureResources: (() => void) | undefined
  let sessionToken = 0

  function step(): void {
    const now = performance.now()
    const dt = prevTime > 0 ? Math.min(64, now - prevTime) : 16.67
    prevTime = now
    hue.value = (now * 0.07) % 360

    if (analysers && context) {
      analysers[0].getByteFrequencyData(bins)
      computeChannelBands(bins, context.sampleRate, 0, raw)
      analysers[1].getByteFrequencyData(bins)
      computeChannelBands(bins, context.sampleRate, 1, raw)
    }

    let frameMax = 0
    let frameSum = 0
    for (let i = 0; i < STEREO_BANDS; i++) {
      const value = raw[i] ?? 0
      if (value > frameMax) frameMax = value
      frameSum += value
    }

    if (frameMax === 0 && previewCount.value > 0) {
      for (let i = 0; i < STEREO_BANDS; i++) {
        targets[i] = demoBandTarget(i, now)
      }
    } else {
      runningPeak = frameMax > runningPeak
        ? runningPeak + (frameMax - runningPeak) * 0.14
        : Math.max(0.25, runningPeak * 0.997)
      const frameMean = frameSum / STEREO_BANDS / runningPeak
      for (let i = 0; i < STEREO_BANDS; i++) {
        const norm = Math.min(1, (raw[i] ?? 0) / runningPeak)
        const prominence = Math.max(0, norm - frameMean * 0.28) / Math.max(0.6, 1 - frameMean * 0.22)
        targets[i] = Math.min(1, norm * 0.55 + prominence * 0.45)
      }
    }

    const release = decayMs.value > 0 ? 1 - Math.exp(-dt / decayMs.value) : 1
    for (let i = 0; i < STEREO_BANDS; i++) {
      const prev = targets[Math.max(0, i - 1)] ?? 0
      const curr = targets[i] ?? 0
      const next = targets[Math.min(STEREO_BANDS - 1, i + 1)] ?? 0
      const target = prev * 0.22 + curr * 0.56 + next * 0.22
      const current = bands.value[i] ?? 0
      const updated = current + (target - current) * (target > current ? 0.4 : release)
      bands.value[i] = updated < 0.002 ? 0 : updated
    }

    activity.value = frameMax > 0 || previewCount.value > 0
      ? Math.min(1, activity.value + (1 - activity.value) * 0.18)
      : Math.max(0, activity.value * (1 - release) - 0.002)
    if (activity.value > 0) triggerRef(bands)
  }

  const { pause, resume } = useRafFn(step, { immediate: false })
  const active = computed(() => activity.value > 0)

  function resetSignalState(): void {
    analysers = undefined
    context = undefined
    raw.fill(0)
    targets.fill(0)
    bands.value.fill(0)
    runningPeak = 0.3
    if (previewCount.value === 0) {
      pause()
      activity.value = 0
    }
  }

  function stopCapture(): void {
    sessionToken++
    const cleanup = releaseCaptureResources
    releaseCaptureResources = undefined
    cleanup?.()
    resetSignalState()
  }

  async function stopAndDisable(): Promise<void> {
    stopCapture()
    if (appearance.settings.outlineAudio) {
      await appearance.set({ outlineAudio: false })
    }
  }

  function connectAudioStream(ctx: AudioContext, audioTrack: MediaStreamTrack): void {
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
    const upmix = ctx.createGain()
    upmix.channelCount = 2
    upmix.channelCountMode = "explicit"
    upmix.channelInterpretation = "speakers"
    const splitter = ctx.createChannelSplitter(2)
    source.connect(upmix)
    upmix.connect(splitter)

    const nodes = [0, 1].map(ch => {
      const node = ctx.createAnalyser()
      node.fftSize = FFT_SIZE
      node.smoothingTimeConstant = SMOOTHING
      node.minDecibels = MIN_DB
      node.maxDecibels = MAX_DB
      splitter.connect(node, ch)
      return node
    }) as [AnalyserNode, AnalyserNode]

    // Desktop keeps the saved preference and recaptures on the next gesture; Web must ask the user to share again.
    const onEnded = isDesktopLoopback ? startDesktopLoopback : () => { void stopAndDisable() }
    audioTrack.addEventListener("ended", onEnded, { once: true })
    context = ctx
    analysers = nodes
    releaseCaptureResources = () => {
      audioTrack.removeEventListener("ended", onEnded)
      audioTrack.stop()
      void ctx.close()
    }
    prevTime = 0
    resume()
    step()
  }

  function attachNativeSubscriptions(api: OutlineAudioApi): void {
    const offSpectrum = api.onSpectrum(({ sampleRate, bins: incoming }) => {
      computeChannelBands(incoming.subarray(0, OUTLINE_SPECTRUM_BINS), sampleRate, 0, raw)
      computeChannelBands(incoming.subarray(OUTLINE_SPECTRUM_BINS, OUTLINE_SPECTRUM_BINS * 2), sampleRate, 1, raw)
    })
    const offStopped = api.onStopped(() => { void stopAndDisable() })
    releaseCaptureResources = () => {
      offSpectrum()
      offStopped()
      void api.stop()
    }
    prevTime = 0
    resume()
    step()
  }

  /** Resolves false when a newer session superseded this capture. */
  async function captureDisplayStream(token: number): Promise<boolean> {
    // Create and resume the context before the first await so strict browsers unlock it within the user gesture.
    const ctx = new AudioContext()
    void ctx.resume()
    let audioTrack: MediaStreamTrack | undefined
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: "include",
      } as DisplayMediaStreamOptions)
      audioTrack = media.getAudioTracks()[0]
      for (const track of media.getTracks()) {
        if (track !== audioTrack) track.stop()
      }
      if (!audioTrack) throw new Error(i18n.global.t("appearance.outlineAudioNoAudio"))
    } catch (reason) {
      void ctx.close()
      throw reason
    }
    if (token !== sessionToken) {
      audioTrack.stop()
      void ctx.close()
      return false
    }
    connectAudioStream(ctx, audioTrack)
    return true
  }

  function startDesktopLoopback(): void {
    stopCapture()
    if (!supported.value) return
    const token = sessionToken
    prevTime = 0
    resume()
    const begin = () => {
      captureDisplayStream(token).catch(reason => {
        console.warn("Could not start outline audio loopback:", reason)
      })
    }
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      const stop = useEventListener(["pointerdown", "keydown"], () => {
        stop()
        if (token === sessionToken) begin()
      }, { capture: true, once: true })
      releaseCaptureResources = stop
      return
    }
    begin()
  }

  if (isDesktopLoopback) {
    watch(() => appearance.settings.outlineAudio, enabled => {
      if (enabled) startDesktopLoopback()
      else stopCapture()
    }, { immediate: true })
  }

  async function initialize(): Promise<void> {
    if (nativeApi) {
      const status = await nativeApi.status()
      supported.value = status.supported
      if (status.active) attachNativeSubscriptions(nativeApi)
      if (appearance.settings.outlineAudio !== status.active) {
        await appearance.set({ outlineAudio: status.active })
      }
      return
    }
    // A browser reload drops the shared stream; the user must share again.
    if (!isDesktopLoopback && appearance.settings.outlineAudio) {
      await appearance.set({ outlineAudio: false })
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    error.value = null
    if (!enabled) return stopAndDisable()
    if (isDesktopLoopback) {
      await appearance.set({ outlineAudio: true })
      return
    }

    stopCapture()
    const token = sessionToken
    starting.value = true
    try {
      let started: boolean
      if (nativeApi) {
        started = await nativeApi.start()
        if (token !== sessionToken) {
          if (started) await nativeApi.stop()
          return
        }
        if (started) attachNativeSubscriptions(nativeApi)
      } else {
        started = await captureDisplayStream(token)
      }
      if (token === sessionToken && started !== appearance.settings.outlineAudio) {
        await appearance.set({ outlineAudio: started })
      }
    } catch (reason) {
      if (token !== sessionToken) return
      if (!isUserCancellation(reason)) error.value = formatOutlineAudioError(reason)
      if (appearance.settings.outlineAudio) {
        await appearance.set({ outlineAudio: false })
      }
    } finally {
      starting.value = false
    }
  }

  function startPreview(): () => void {
    previewCount.value++
    prevTime = 0
    resume()
    return () => {
      previewCount.value = Math.max(0, previewCount.value - 1)
      if (previewCount.value === 0 && !releaseCaptureResources) {
        pause()
        bands.value.fill(0)
        activity.value = 0
      }
    }
  }

  function width(index: number, count: number, baseline: number, targetMaxWidth: number): number {
    const mix = activity.value
    if (mix <= 0) return baseline
    const pos = (count > 1 ? (index / (count - 1)) ** 1.27 : 0.5) * (STEREO_BANDS - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(STEREO_BANDS - 1, lo + 1)
    const energy = (bands.value[lo] ?? 0) * (1 - (pos - lo)) + (bands.value[hi] ?? 0) * (pos - lo)
    const audioWidth = OUTLINE_MIN_WIDTH + energy * (Math.max(OUTLINE_MIN_WIDTH, targetMaxWidth) - OUTLINE_MIN_WIDTH)
    return baseline * (1 - mix) + audioWidth * mix
  }

  function color(index: number, highlighted: boolean): string {
    const deg = (((hue.value - index * 18) % 360) + 360) % 360
    const { l, c, h } = fittedOklch(500, deg)
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)}deg / ${highlighted ? 1 : 0.72})`
  }

  onScopeDispose(stopCapture)

  return {
    supported, starting, error, decayOverride, active,
    initialize, setEnabled, startPreview, width, color,
  }
})

type OutlineAudioStore = ReturnType<typeof defineOutlineAudioStore>
export const outlineAudioStoreKey: InjectionKey<OutlineAudioStore> = Symbol("client-outline-audio")

/** Nested machine apps reuse the client-owned audio controller across routes and machines. */
export function useOutlineAudioStore(pinia?: Pinia): OutlineAudioStore {
  return (!pinia && hasInjectionContext() ? inject(outlineAudioStoreKey, undefined) : undefined)
    ?? defineOutlineAudioStore(pinia)
}
