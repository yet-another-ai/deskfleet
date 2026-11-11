import { DEFAULT_APPEARANCE_SETTINGS } from "@deskfleet/client/appearance"
import { OUTLINE_SPECTRUM_BINS, type OutlineAudioApi, type OutlineAudioSpectrumFrame } from "@deskfleet/client/outline-audio"
import { configureClient, getClient } from "@deskfleet/client/platform"
import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import AgentOutline from "../components/session/AgentOutline.vue"
import { i18n } from "../i18n/index.ts"
import { mountDeskfleet } from "../mount.ts"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "./appearance.ts"
import { computeChannelBands, useOutlineAudioStore } from "./outline-audio.ts"

class FakeTrack extends EventTarget {
  readonly kind: "audio" | "video"
  readyState: MediaStreamTrackState = "live"
  readonly stop = vi.fn(() => {
    this.readyState = "ended"
  })

  constructor(kind: "audio" | "video") {
    super()
    this.kind = kind
  }

  end(): void {
    this.readyState = "ended"
    this.dispatchEvent(new Event("ended"))
  }
}

class FakeMediaStream {
  private readonly tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }

  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[]
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter(t => t.kind === "video") as unknown as MediaStreamTrack[]
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter(t => t.kind === "audio") as unknown as MediaStreamTrack[]
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static binByte = 220
  state: AudioContextState = "suspended"
  readonly sampleRate = 48_000
  readonly resume = vi.fn(async () => {
    this.state = "running"
  })
  readonly close = vi.fn(async () => {
    this.state = "closed"
  })
  readonly createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  readonly createGain = vi.fn(() => ({
    channelCount: 2,
    channelCountMode: "max",
    channelInterpretation: "speakers",
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  readonly createChannelSplitter = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))
  readonly createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    minDecibels: -100,
    maxDecibels: -30,
    frequencyBinCount: 2048,
    getByteFrequencyData: (target: Uint8Array) => {
      target.fill(FakeAudioContext.binByte)
    },
  }))

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

const host = getClient()
const originalAudioContext = globalThis.AudioContext
const originalMediaStream = globalThis.MediaStream
const originalMediaDevices = navigator.mediaDevices
let pinia: Pinia

beforeEach(() => {
  localStorage.clear()
  FakeAudioContext.instances = []
  FakeAudioContext.binByte = 220
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  })
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    writable: true,
    value: FakeMediaStream,
  })
  pinia = createPinia()
})

afterEach(() => {
  disposePinia(pinia)
  configureClient(host)
  localStorage.clear()
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: originalAudioContext,
  })
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    writable: true,
    value: originalMediaStream,
  })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: originalMediaDevices,
  })
  i18n.global.locale.value = "en-US"
  vi.restoreAllMocks()
})

test("web capture unlocks AudioContext synchronously, survives AgentOutline unmount, and resets when sharing stops", async () => {
  const videoTrack = new FakeTrack("video")
  const audioTrack = new FakeTrack("audio")
  let contextStateDuringPrompt: AudioContextState | undefined
  const getDisplayMedia = vi.fn(async () => {
    contextStateDuringPrompt = FakeAudioContext.instances[0]?.state
    return new FakeMediaStream([videoTrack, audioTrack]) as unknown as MediaStream
  })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getDisplayMedia },
  })
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_APPEARANCE_SETTINGS, outlineAudio: true }),
  )

  configureClient({ ...host, platform: "web", mobile: false, appearance: undefined, outlineAudio: undefined })
  const appearance = useAppearanceStore(pinia)
  const outlineAudio = useOutlineAudioStore(pinia)
  await outlineAudio.initialize()

  // Stale outlineAudio from a previous browser reload resets until explicitly shared.
  expect(appearance.settings.outlineAudio).toBe(false)
  expect(getDisplayMedia).not.toHaveBeenCalled()

  await outlineAudio.setEnabled(true)
  expect(FakeAudioContext.instances).toHaveLength(1)
  expect(FakeAudioContext.instances[0]!.resume).toHaveBeenCalled()
  expect(contextStateDuringPrompt).toBe("running")
  expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ systemAudio: "include" }))
  expect(videoTrack.stop).toHaveBeenCalledOnce()
  expect(audioTrack.stop).not.toHaveBeenCalled()
  expect(appearance.settings.outlineAudio).toBe(true)
  expect(outlineAudio.active).toBe(true)

  // Unmounting the settings preview must keep the shared capture stream alive for SessionView.
  const preview = mount(AgentOutline, {
    props: { preview: true },
    global: { plugins: [pinia, i18n] },
  })
  preview.unmount()
  expect(audioTrack.stop).not.toHaveBeenCalled()
  expect(FakeAudioContext.instances[0]!.close).not.toHaveBeenCalled()
  expect(appearance.settings.outlineAudio).toBe(true)

  // Clicking the browser's "Stop sharing" indicator cleans up and turns off the preference.
  audioTrack.end()
  await Promise.resolve()
  expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledOnce()
  expect(appearance.settings.outlineAudio).toBe(false)
})

test("desktop loopback keeps the saved preference and recaptures on the next gesture after the track ends", async () => {
  const audioTracks: FakeTrack[] = []
  const getDisplayMedia = vi.fn(async () => {
    const track = new FakeTrack("audio")
    audioTracks.push(track)
    return new FakeMediaStream([new FakeTrack("video"), track]) as unknown as MediaStream
  })
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, writable: true, value: { getDisplayMedia } })
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: false } })
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE_SETTINGS, outlineAudio: true }))
  configureClient({ ...host, platform: "darwin", mobile: false, appearance: undefined, outlineAudio: undefined })

  try {
    const appearance = useAppearanceStore(pinia)
    const outlineAudio = useOutlineAudioStore(pinia)
    await outlineAudio.initialize()

    // Capture waits for a user gesture instead of prompting at startup.
    expect(getDisplayMedia).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("pointerdown"))
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.createMediaStreamSource).toHaveBeenCalled())

    audioTracks[0]!.end()
    expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledOnce()
    expect(appearance.settings.outlineAudio).toBe(true)
    expect(getDisplayMedia).toHaveBeenCalledOnce()

    window.dispatchEvent(new Event("pointerdown"))
    await vi.waitFor(() => expect(FakeAudioContext.instances[1]?.createMediaStreamSource).toHaveBeenCalled())
    expect(getDisplayMedia).toHaveBeenCalledTimes(2)
    expect(appearance.settings.outlineAudio).toBe(true)

    // When OS loopback capture fails, desktop reports the error and resets the preference.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    getDisplayMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"))
    audioTracks[1]!.end()
    window.dispatchEvent(new Event("pointerdown"))
    await vi.waitFor(() => expect(appearance.settings.outlineAudio).toBe(false))
    expect(outlineAudio.error).toBe("Audio capture permission was denied.")
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  } finally {
    Reflect.deleteProperty(navigator, "userActivation")
  }
})

test("auxiliary preview windows skip outline audio initialization", async () => {
  const getDisplayMedia = vi.fn(async () => new FakeMediaStream([new FakeTrack("video"), new FakeTrack("audio")]) as unknown as MediaStream)
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, writable: true, value: { getDisplayMedia } })
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE_SETTINGS, outlineAudio: true }))
  configureClient({ ...host, platform: "web", mobile: false, appearance: undefined, outlineAudio: undefined })

  const previousHash = window.location.hash
  const container = document.createElement("div")
  document.body.appendChild(container)
  window.location.hash = "#/preview?kind=text&content=hello"
  try {
    const app = await mountDeskfleet(container)
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!) as { outlineAudio: boolean }
    expect(saved.outlineAudio).toBe(true)
    expect(getDisplayMedia).not.toHaveBeenCalled()
    app.unmount()
  } finally {
    window.location.hash = previousHash
    container.remove()
  }
})

test("web capture reports missing audio tracks and ignores user picker cancellation", async () => {
  const videoOnly = new FakeTrack("video")
  const getDisplayMedia = vi.fn<MediaDevices["getDisplayMedia"]>()
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getDisplayMedia },
  })
  configureClient({ ...host, platform: "web", mobile: false, appearance: undefined, outlineAudio: undefined })

  const appearance = useAppearanceStore(pinia)
  const outlineAudio = useOutlineAudioStore(pinia)
  await outlineAudio.initialize()

  getDisplayMedia.mockResolvedValueOnce(new FakeMediaStream([videoOnly]) as unknown as MediaStream)
  await outlineAudio.setEnabled(true)
  expect(videoOnly.stop).toHaveBeenCalledOnce()
  expect(appearance.settings.outlineAudio).toBe(false)
  expect(outlineAudio.error).toContain("Share audio")

  getDisplayMedia.mockRejectedValueOnce(new DOMException("Permission dismissed", "NotAllowedError"))
  await outlineAudio.setEnabled(true)
  expect(appearance.settings.outlineAudio).toBe(false)
  expect(outlineAudio.error).toBeNull()
})

test("mobile outlineAudio delegates to native broadcast capture, animates bands, and handles external stop", async () => {
  let pushSpectrum: ((frame: OutlineAudioSpectrumFrame) => void) | undefined
  let pushStopped: (() => void) | undefined
  const start = vi.fn<OutlineAudioApi["start"]>()
  const stop = vi.fn(async () => {})
  const nativeOutlineAudio: OutlineAudioApi = {
    status: vi.fn(async () => ({ supported: true, active: false })),
    start,
    stop,
    onSpectrum: vi.fn(listener => {
      pushSpectrum = listener
      return () => { pushSpectrum = undefined }
    }),
    onStopped: vi.fn(listener => {
      pushStopped = listener
      return () => { pushStopped = undefined }
    }),
  }

  configureClient({
    ...host,
    platform: "web",
    mobile: true,
    appearance: undefined,
    outlineAudio: nativeOutlineAudio,
  })
  const appearance = useAppearanceStore(pinia)
  const outlineAudio = useOutlineAudioStore(pinia)
  await outlineAudio.initialize()

  start.mockResolvedValueOnce(false)
  await outlineAudio.setEnabled(true)
  expect(appearance.settings.outlineAudio).toBe(false)
  expect(outlineAudio.error).toBeNull()

  start.mockResolvedValueOnce(true)
  await outlineAudio.setEnabled(true)
  expect(appearance.settings.outlineAudio).toBe(true)

  pushSpectrum?.({ sampleRate: 48_000, bins: new Uint8Array(OUTLINE_SPECTRUM_BINS * 2).fill(220) })
  await new Promise(resolve => requestAnimationFrame(resolve))
  expect(outlineAudio.width(4, 10, 12, 48)).toBeGreaterThan(12)

  pushStopped?.()
  await Promise.resolve()
  expect(appearance.settings.outlineAudio).toBe(false)

  start.mockRejectedValueOnce(Object.assign(new Error("Audio capture permission denied."), { code: "permission-denied" }))
  await outlineAudio.setEnabled(true)
  expect(appearance.settings.outlineAudio).toBe(false)
  expect(outlineAudio.error).toBe("Audio capture permission was denied.")
})

test("computeChannelBands maps left and right spectrum bins symmetrically", () => {
  const bins = new Uint8Array(OUTLINE_SPECTRUM_BINS)
  bins[38] = 220 // ~445 Hz at 48 kHz
  const out = new Float32Array(48)
  computeChannelBands(bins, 48_000, 0, out)
  computeChannelBands(bins, 48_000, 1, out)
  for (let band = 0; band < 24; band++) {
    expect(out[23 - band]).toBeCloseTo(out[24 + band]!, 6)
  }
  expect(Math.max(...out)).toBeGreaterThan(0.5)
})
