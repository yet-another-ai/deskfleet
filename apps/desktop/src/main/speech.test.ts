import { EventEmitter } from "node:events"
import { beforeEach, expect, test, vi } from "vitest"
import { SPEECH_CHANNEL, SPEECH_EVENT } from "@deskfleet/client/speech"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() } }))
vi.mock("@deskfleet/native", () => ({ createSpeech: vi.fn(), speechStatus: vi.fn() }))
import { BrowserWindow, ipcMain } from "electron"
import { createSpeech, speechStatus } from "@deskfleet/native"
import { installSpeech } from "./speech.ts"

function owner() {
  return Object.assign(new EventEmitter(), {
    mainFrame: { url: BUNDLED_RENDERER_URL }, send: vi.fn(), isDestroyed: () => false,
  })
}
function fixture() {
  const sender = owner()
  const window = new EventEmitter()
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as Electron.BrowserWindow)
  const service = installSpeech()
  const [channel, invoke] = vi.mocked(ipcMain.handle).mock.calls.at(-1)!
  expect(channel).toBe(SPEECH_CHANNEL)
  const event = { sender, senderFrame: sender.mainFrame } as unknown as Electron.IpcMainInvokeEvent
  return { sender, window, service, event, invoke }
}
function native() {
  type NativeEvent = Awaited<ReturnType<Awaited<ReturnType<typeof createSpeech>>["nextEvent"]>>
  let deliver!: (event: NativeEvent) => void
  const value = {
    nextEvent: vi.fn(() => new Promise<NativeEvent>(resolve => { deliver = resolve })),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => { deliver?.(null) }),
  }
  vi.mocked(createSpeech).mockResolvedValue(value as unknown as Awaited<ReturnType<typeof createSpeech>>)
  return value
}
beforeEach(() => vi.resetAllMocks())

test("only trusted main frames may query or start speech", async () => {
  const { event, invoke } = fixture()
  const bad = { ...event, senderFrame: { url: BUNDLED_RENDERER_URL } } as Electron.IpcMainInvokeEvent
  await expect(invoke(bad, "status", "en-US")).rejects.toThrow("restricted")
  await expect(invoke(event, "start", { sessionId: "one", locale: "invalid_locale" })).rejects.toThrow()
  expect(speechStatus).not.toHaveBeenCalled()
  expect(createSpeech).not.toHaveBeenCalled()
})

test("status does not create a recognizer and delegates the requested language", async () => {
  const { event, invoke } = fixture()
  vi.mocked(speechStatus).mockResolvedValue({ supported: true })
  expect(await invoke(event, "status", "en-us")).toEqual({ supported: true })
  expect(speechStatus).toHaveBeenCalledWith("en-US")
  expect(createSpeech).not.toHaveBeenCalled()
})

test("another window cannot stop recording and hiding the owner releases the microphone", async () => {
  const { event, invoke, window } = fixture()
  const recognition = native()
  await invoke(event, "start", { sessionId: "one", locale: "en-US" })
  const other = owner()
  await invoke({ sender: other, senderFrame: other.mainFrame } as unknown as Electron.IpcMainInvokeEvent, "stop", "one")
  expect(recognition.stop).not.toHaveBeenCalled()
  await invoke(event, "stop", "one")
  expect(recognition.stop).toHaveBeenCalledOnce()
  window.emit("hide")
  await vi.waitFor(() => expect(recognition.cancel).toHaveBeenCalledOnce())
})

test("closing while creation is pending cancels the native instance without delivering events", async () => {
  const { event, invoke, service, sender } = fixture()
  const recognition = native()
  let ready!: (value: Awaited<ReturnType<typeof createSpeech>>) => void
  vi.mocked(createSpeech).mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
  const starting = invoke(event, "start", { sessionId: "one", locale: "en-US" })
  const closing = service.close()
  ready(recognition as unknown as Awaited<ReturnType<typeof createSpeech>>)
  await Promise.all([starting, closing])
  expect(recognition.cancel).toHaveBeenCalledOnce()
  expect(recognition.nextEvent).not.toHaveBeenCalled()
  expect(sender.send).not.toHaveBeenCalledWith(SPEECH_EVENT, expect.anything())
})

test("native ended stops polling, detaches lifetime handlers, and allows a new dictation", async () => {
  const { event, invoke, sender, window, service } = fixture()
  const first = native()
  first.nextEvent.mockResolvedValueOnce({ sessionId: "one", type: "ended" })
  await invoke(event, "start", { sessionId: "one", locale: "en-US" })
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(SPEECH_EVENT, { sessionId: "one", type: "ended" }))
  expect(first.nextEvent).toHaveBeenCalledOnce()
  expect(sender.listenerCount("destroyed")).toBe(0)
  expect(window.listenerCount("hide")).toBe(0)
  const second = native()
  await invoke(event, "start", { sessionId: "two", locale: "en-US" })
  expect(second.nextEvent).toHaveBeenCalledOnce()
  await service.close()
  expect(second.cancel).toHaveBeenCalledOnce()
})

test("a closed native event stream ends the renderer state", async () => {
  const { event, invoke, sender } = fixture()
  const recognition = native()
  recognition.nextEvent.mockResolvedValueOnce(null)
  await invoke(event, "start", { sessionId: "one", locale: "en-US" })
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(SPEECH_EVENT, { sessionId: "one", type: "ended" }))
  expect(recognition.nextEvent).toHaveBeenCalledOnce()
})

test("a native event failure cancels capture before reporting the failure and ending", async () => {
  const { event, invoke, sender } = fixture()
  const recognition = native()
  recognition.nextEvent.mockRejectedValueOnce(new Error("native event failed"))
  await invoke(event, "start", { sessionId: "one", locale: "en-US" })
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(SPEECH_EVENT, { sessionId: "one", type: "ended" }))
  expect(recognition.cancel).toHaveBeenCalledOnce()
  expect(sender.send.mock.calls).toEqual([
    [SPEECH_EVENT, { sessionId: "one", type: "error", code: "failed" }],
    [SPEECH_EVENT, { sessionId: "one", type: "ended" }],
  ])
})
