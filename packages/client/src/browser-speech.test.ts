import { afterEach, expect, test, vi } from "vitest"
import { createBrowserSpeechApi, isChromeSpeechBrowser } from "./browser-speech.ts"
import type { SpeechEvent } from "./speech.ts"

class Recognizer {
  static instances: Recognizer[] = []
  lang = ""
  continuous = false
  interimResults = false
  onstart: (() => void) | null = null
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  start = vi.fn(() => this.onstart?.())
  stop = vi.fn()
  abort = vi.fn()
  constructor() { Recognizer.instances.push(this) }
}

function fixture() {
  Recognizer.instances = []
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] }
  const getUserMedia = vi.fn(async () => stream)
  vi.stubGlobal("window", { isSecureContext: true, webkitSpeechRecognition: Recognizer })
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36", vendor: "Google Inc.", mediaDevices: { getUserMedia } })
  vi.stubGlobal("AudioContext", undefined)
  const api = createBrowserSpeechApi()!
  const events: SpeechEvent[] = []
  api.onEvent(event => events.push(event))
  return { api, events, getUserMedia, stream, stopTrack }
}

afterEach(() => vi.unstubAllGlobals())

test("only Chrome with a speech constructor and secure microphone access exposes dictation", () => {
  expect(isChromeSpeechBrowser("Chrome/145.0", "Google Inc.")).toBe(true)
  for (const agent of ["Chrome/145.0 Electron/45.2", "Chrome/145.0 Edg/145.0", "Chrome/145.0 OPR/110.0", "Firefox/145.0"]) {
    expect(isChromeSpeechBrowser(agent, "Google Inc.")).toBe(false)
  }
  fixture()
  vi.stubGlobal("window", { isSecureContext: false, SpeechRecognition: Recognizer })
  expect(createBrowserSpeechApi()).toBeUndefined()
  vi.stubGlobal("window", { isSecureContext: true })
  expect(createBrowserSpeechApi()).toBeUndefined()
})

test("availability never opens the microphone and final results remain cumulative", async () => {
  const { api, events, getUserMedia, stopTrack } = fixture()
  expect(await api.status("zh-CN")).toEqual({ supported: true })
  expect(getUserMedia).not.toHaveBeenCalled()
  await api.start({ sessionId: "one", locale: "zh-CN" })
  const recognition = Recognizer.instances[0]!
  recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "Hello " } }, { isFinal: false, 0: { transcript: "wor" } }] })
  expect(events.slice(-2)).toEqual([
    { sessionId: "one", type: "result", text: "Hello ", final: true },
    { sessionId: "one", type: "result", text: "Hello wor", final: false },
  ])
  await api.stop("one")
  expect(recognition.stop).toHaveBeenCalledOnce()
  expect(stopTrack).toHaveBeenCalledOnce()
  recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "Hello " } }, { isFinal: true, 0: { transcript: "world" } }] })
  recognition.onend?.()
  expect(events.slice(-2)).toEqual([
    { sessionId: "one", type: "result", text: "Hello world", final: true },
    { sessionId: "one", type: "ended" },
  ])
  expect(stopTrack).toHaveBeenCalledOnce()
})

test("cancelling pending microphone consent releases a late stream without starting recognition", async () => {
  const { api, getUserMedia, stream, stopTrack, events } = fixture()
  let grant!: (value: typeof stream) => void
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
  const starting = api.start({ sessionId: "cancelled", locale: "en-US" })
  await api.cancel("cancelled")
  grant(stream)
  await starting
  expect(Recognizer.instances).toHaveLength(0)
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(events).toEqual([{ sessionId: "cancelled", type: "ended" }])
})

test("late microphone consent cannot stop or publish into a newer dictation", async () => {
  const { api, getUserMedia, stream, stopTrack, events } = fixture()
  let grant!: (value: typeof stream) => void
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
  const oldStart = api.start({ sessionId: "old", locale: "en-US" })
  await api.cancel("old")
  const newTrackStop = vi.fn()
  getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop: newTrackStop }] })
  await api.start({ sessionId: "new", locale: "en-US" })
  grant(stream)
  await oldStart
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(newTrackStop).not.toHaveBeenCalled()
  expect(Recognizer.instances).toHaveLength(1)
  expect(events).toEqual([{ sessionId: "old", type: "ended" }, { sessionId: "new", type: "started" }])
  await api.cancel("new")
  expect(newTrackStop).toHaveBeenCalledOnce()
})

test("the microphone meter reports measured levels and stop releases capture before final results", async () => {
  const { api, events, stopTrack } = fixture()
  const close = vi.fn(async () => {})
  const connect = vi.fn()
  const analyser = { fftSize: 0, getFloatTimeDomainData: (data: Float32Array) => data.fill(0.1) }
  vi.stubGlobal("AudioContext", class {
    close = close
    resume = async () => {}
    createAnalyser = () => analyser
    createMediaStreamSource = () => ({ connect })
  })
  let frame = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame })
  const cancelFrame = vi.fn((id: number) => frames.delete(id))
  vi.stubGlobal("cancelAnimationFrame", cancelFrame)
  await api.start({ sessionId: "meter", locale: "en-US" })
  const tick = frames.get(1)!
  frames.delete(1)
  tick(100)
  const level = events.find(event => event.type === "level")
  expect(level?.type === "level" && level.level).toBeCloseTo(0.5)
  expect(connect).toHaveBeenCalledWith(analyser)
  await api.stop("meter")
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
  const recognition = Recognizer.instances[0]!
  recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "finished" } }] })
  recognition.onend?.()
  expect(events.slice(-2)).toEqual([
    { sessionId: "meter", type: "result", text: "finished", final: true },
    { sessionId: "meter", type: "ended" },
  ])
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

test("an ended listener can immediately start the next dictation", async () => {
  const { api } = fixture()
  let next: Promise<void> | undefined
  api.onEvent(event => { if (event.type === "ended" && event.sessionId === "one") next = api.start({ sessionId: "two", locale: "en-US" }) })
  await api.start({ sessionId: "one", locale: "en-US" })
  Recognizer.instances[0]!.onend?.()
  await next
  expect(Recognizer.instances).toHaveLength(2)
  expect(Recognizer.instances[1]!.start).toHaveBeenCalledOnce()
  await api.cancel("two")
})

test("a service error ends capture and stale callbacks cannot write into the next run", async () => {
  const { api, events, stopTrack } = fixture()
  await api.start({ sessionId: "one", locale: "en-US" })
  const recognition = Recognizer.instances[0]!
  const staleResult = recognition.onresult!
  recognition.onerror?.({ error: "network" })
  expect(events.slice(-2)).toEqual([{ sessionId: "one", type: "error", code: "network" }, { sessionId: "one", type: "ended" }])
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(recognition.abort).toHaveBeenCalledOnce()
  await api.start({ sessionId: "two", locale: "en-US" })
  const count = events.length
  staleResult({ results: [{ isFinal: true, 0: { transcript: "late" } }] })
  expect(events).toHaveLength(count)
  await api.cancel("one")
  expect(Recognizer.instances[1]!.abort).not.toHaveBeenCalled()
  await api.cancel("two")
})
