import { expect, test, vi } from "vitest"
import type { PluginListenerHandle } from "@capacitor/core"
import type { SpeechEvent } from "@deskfleet/client/speech"
import { createCapacitorSpeechApi, type SpeechBridgePlugin } from "./speech.ts"

function fixture(listenerReady: Promise<PluginListenerHandle> = Promise.resolve({ remove: async () => {} })) {
  let receive: (event: SpeechEvent) => void = () => {}
  const plugin: SpeechBridgePlugin = {
    speechStatus: vi.fn(async () => ({ supported: true })),
    addListener: vi.fn((_name, listener) => {
      receive = listener
      return listenerReady
    }),
    startSpeech: vi.fn(async ({ sessionId }) => { receive({ sessionId, type: "started" }) }),
    stopSpeech: vi.fn(async () => {}),
    cancelSpeech: vi.fn(async () => {}),
  }
  const api = createCapacitorSpeechApi(plugin)
  const events: SpeechEvent[] = []
  const unsubscribe = api.onEvent(event => events.push(event))
  return { api, plugin, events, unsubscribe, receive: (event: SpeechEvent) => receive(event) }
}

test("speech capability checks do not start recording or attach native listeners", async () => {
  const { api, plugin } = fixture()
  await expect(api.status("zh-CN")).resolves.toEqual({ supported: true })
  expect(plugin.speechStatus).toHaveBeenCalledWith({ locale: "zh-CN" })
  expect(plugin.addListener).not.toHaveBeenCalled()
  expect(plugin.startSpeech).not.toHaveBeenCalled()
})

test("speech start waits for the native listener and cancellation prevents a delayed start", async () => {
  let ready!: (handle: PluginListenerHandle) => void
  const f = fixture(new Promise(resolve => { ready = resolve }))
  const pending = f.api.start({ sessionId: "one", locale: "en-US" })
  expect(f.plugin.startSpeech).not.toHaveBeenCalled()
  await f.api.cancel("one")
  ready({ remove: async () => {} })
  await pending
  expect(f.plugin.cancelSpeech).toHaveBeenCalledWith({ sessionId: "one" })
  expect(f.plugin.startSpeech).not.toHaveBeenCalled()
  f.receive({ sessionId: "one", type: "result", text: "late", final: true })
  expect(f.events).toEqual([])
})

test("speech replaces sessions, preserves final-before-ended order, and drops stale callbacks", async () => {
  const f = fixture()
  await f.api.start({ sessionId: "one", locale: "en-US" })
  await f.api.start({ sessionId: "two", locale: "zh-CN" })
  expect(f.plugin.cancelSpeech).toHaveBeenCalledWith({ sessionId: "one" })
  expect(f.plugin.addListener).toHaveBeenCalledOnce()
  f.receive({ sessionId: "one", type: "ended" })
  f.receive({ sessionId: "two", type: "result", text: "你好", final: false })
  await f.api.stop("two")
  f.receive({ sessionId: "two", type: "result", text: "你好。", final: true })
  f.receive({ sessionId: "two", type: "ended" })
  f.receive({ sessionId: "two", type: "result", text: "stale", final: true })
  expect(f.events).toEqual([
    { sessionId: "one", type: "started" },
    { sessionId: "two", type: "started" },
    { sessionId: "two", type: "result", text: "你好", final: false },
    { sessionId: "two", type: "result", text: "你好。", final: true },
    { sessionId: "two", type: "ended" },
  ])
  expect(f.plugin.stopSpeech).toHaveBeenCalledWith({ sessionId: "two" })
  f.unsubscribe()
  await f.api.start({ sessionId: "three", locale: "en-US" })
  expect(f.events).toHaveLength(5)
})
