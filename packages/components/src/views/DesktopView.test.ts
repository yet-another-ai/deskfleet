import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../i18n/index.ts"
import { router } from "../router/index.ts"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../test/desktop-media.ts"
import DesktopView from "./DesktopView.vue"

const originalApi = platformClient.desktop
let mock: ReturnType<typeof mockDesktopApi>
const wrappers: VueWrapper[] = []
async function mountDesktop(machineId = "local-daemon") {
  const wrapper = mount(DesktopView, {
    props: { machineId },
    global: { plugins: [createPinia(), router, i18n] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
function button(wrapper: VueWrapper, label: string) {
  return wrapper.findAll("button").find((entry) => entry.text() === label)!
}
beforeEach(() => {
  stubWebRtc()
  mock = mockDesktopApi()
  platformClient.desktop = mock.api
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
  const sources = new WeakMap<HTMLMediaElement, MediaProvider | null>()
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(function (this: HTMLMediaElement, value) {
    sources.set(this, value)
  })
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "get").mockImplementation(function (this: HTMLMediaElement) {
    return sources.get(this) ?? null
  })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  platformClient.desktop = originalApi
  vi.unstubAllGlobals()
})

test("discovers displays without capturing, then connects with the automatic codec", async () => {
  const wrapper = await mountDesktop()
  expect(wrapper.get('[role="status"]').text()).toBe("Choose a display and connect to start sharing. Video codec: H.264.")
  expect(wrapper.findAll("select")).toHaveLength(1)
  const display = wrapper.get("select")
  expect(wrapper.get("[data-desktop-codec]").text()).toBe("Video codec: H.264")
  expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  expect(mock.api.offer).not.toHaveBeenCalled()
  expect(mock.api.start).not.toHaveBeenCalled()

  await display.setValue("2")
  await wrapper.get('input[type="checkbox"]').setValue(true)
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  expect(mock.api.offer).toHaveBeenCalledWith(expect.objectContaining({ codec: "h264", audio: true }))
  expect(wrapper.get('[role="status"]').text()).toBe("Connecting with H.264…")
  expect(button(wrapper, "Disconnect").exists()).toBe(true)
  expect(display.attributes("disabled")).toBeDefined()

  const peer = TestPeer.instances[0]!
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack
  peer.ontrack?.({ track })
  peer.changeState("connected")
  await flushPromises()
  expect(mock.api.start).toHaveBeenCalledWith(expect.objectContaining({ displayId: 2 }))
  expect(wrapper.get('[role="status"]').text()).toBe("Connected · H.264")
  expect((wrapper.get("video").element as HTMLVideoElement).srcObject).toBeTruthy()
  expect(wrapper.find('[aria-label="Full screen"]').exists()).toBe(true)
  await button(wrapper, "Disconnect").trigger("click")
  await flushPromises()
  expect((wrapper.get("video").element as HTMLVideoElement).srcObject).toBeNull()
  expect(track.stop).toHaveBeenCalledTimes(1)
})

test("switching displays selects a codec supported by that display's GPU", async () => {
  mock.api.capabilities.mockResolvedValueOnce({
    displays: [
      { id: 1, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264", "h265", "av1"] },
      { id: 2, width: 2560, height: 1440, refreshRateHz: 60, codecs: ["h264"] },
      { id: 3, width: 1280, height: 720, refreshRateHz: 60, codecs: [] },
    ],
    audio: false,
  })
  const wrapper = await mountDesktop()
  const display = wrapper.get("select")
  expect(wrapper.get("[data-desktop-codec]").text()).toBe("Video codec: H.264")
  await display.setValue("2")
  expect(wrapper.get("[data-desktop-codec]").text()).toBe("Video codec: H.264")
  expect(wrapper.get('[role="status"]').text()).toContain("Video codec: H.264.")

  await display.setValue("3")
  expect(wrapper.find("[data-desktop-codec]").exists()).toBe(false)
  expect(button(wrapper, "Connect").attributes("disabled")).toBeDefined()
  expect(wrapper.get('[role="status"]').text()).toBe("No compatible video codec is available in Electron.")

  await display.setValue("2")
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  expect(mock.api.offer).toHaveBeenCalledWith(expect.objectContaining({ codec: "h264" }))
  TestPeer.instances[0]!.changeState("connected")
  await flushPromises()
  expect(mock.api.start).toHaveBeenCalledWith(expect.objectContaining({ displayId: 2 }))
})

test("an unavailable daemon remains reachable through refresh", async () => {
  mock.api.target.mockRejectedValueOnce(new Error("No daemon discovery file"))
  const wrapper = await mountDesktop()
  expect(wrapper.get('[role="status"]').text()).toContain("The local daemon is unavailable.")
  expect(wrapper.get('[role="alert"]').text()).toBe("No daemon discovery file")
  expect(button(wrapper, "Connect").attributes("disabled")).toBeDefined()
  expect(mock.api.capabilities).not.toHaveBeenCalled()
  await button(wrapper, "Refresh displays").trigger("click")
  await flushPromises()
  expect(button(wrapper, "Connect").attributes("disabled")).toBeUndefined()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

test("reports unsupported capture, missing displays, and incompatible codecs", async () => {
  mock.api.target.mockResolvedValueOnce({ id: "local-daemon", name: "linux-host", online: true, desktop: false })
  const unsupported = await mountDesktop()
  expect(unsupported.get('[role="status"]').text()).toBe("Screen capture is unavailable on this machine.")
  expect(mock.api.capabilities).not.toHaveBeenCalled()

  mock.api.capabilities.mockResolvedValueOnce({ displays: [], audio: false })
  const headless = await mountDesktop()
  expect(headless.get('[role="status"]').text()).toBe("test-host has no display to share.")
  expect(button(headless, "Connect").attributes("disabled")).toBeDefined()

  vi.spyOn(RTCRtpReceiver, "getCapabilities").mockReturnValue({ codecs: [], headerExtensions: [] })
  const incompatible = await mountDesktop()
  expect(incompatible.get('[role="status"]').text()).toBe("No compatible video codec is available in Electron.")
  expect(button(incompatible, "Connect").attributes("disabled")).toBeDefined()
})

test("an unknown machine never starts a real daemon connection", async () => {
  const wrapper = await mountDesktop("machine-development-box")
  expect(wrapper.get('[role="status"]').text()).toBe("This machine does not exist.")
  expect(button(wrapper, "Connect")).toBeUndefined()
  expect(mock.api.target).not.toHaveBeenCalled()
  expect(mock.api.offer).not.toHaveBeenCalled()
  expect(wrapper.find("video").exists()).toBe(false)
})

test("capture errors are visible and the connection can be retried", async () => {
  mock.api.start.mockRejectedValueOnce(new Error("Screen recording permission denied"))
  const wrapper = await mountDesktop()
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  TestPeer.instances[0]!.changeState("connected")
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe("The desktop connection failed.")
  expect(wrapper.get('[role="alert"]').text()).toBe("Screen recording permission denied")
  expect(button(wrapper, "Connect").attributes("disabled")).toBeUndefined()
  expect(mock.api.close).toHaveBeenCalledTimes(1)
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  expect(mock.api.offer).toHaveBeenCalledTimes(2)
})

test("changing machine routes cancels an in-flight offer", async () => {
  const answer = deferred<{ sdp: string }>()
  mock.api.offer.mockReturnValue(answer.promise)
  const wrapper = await mountDesktop()
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  await wrapper.setProps({ machineId: "machine-development-box" })
  await flushPromises()
  expect(mock.api.close).toHaveBeenCalledTimes(1)
  answer.resolve({ sdp: "late-answer" })
  await flushPromises()
  expect(mock.api.start).not.toHaveBeenCalled()
  expect(mock.api.close).toHaveBeenCalledTimes(2)
  expect(wrapper.find("video").exists()).toBe(false)
})

test("stream settings open from the floating toolbar and close with Escape", async () => {
  const wrapper = await mountDesktop()
  const trigger = wrapper.get('[aria-label="Stream settings"]')
  const panel = wrapper.get('[role="dialog"]')
  expect((panel.element as HTMLElement).style.display).toBe("none")
  await trigger.trigger("click")
  expect((panel.element as HTMLElement).style.display).toBe("")
  expect(trigger.attributes("aria-expanded")).toBe("true")
  await panel.trigger("keydown", { key: "Escape" })
  expect((panel.element as HTMLElement).style.display).toBe("none")
  expect(trigger.attributes("aria-expanded")).toBe("false")
})

test("the floating toolbar moves by keyboard and drag, stays inside the stage, and opens settings toward the open side", async () => {
  const wrapper = await mountDesktop()
  const size = (element: Element, sizes: Record<string, number>) => {
    for (const [key, value] of Object.entries(sizes)) Object.defineProperty(element, key, { configurable: true, value })
  }
  size(wrapper.get("[data-desktop-stage]").element, { clientWidth: 800, clientHeight: 600 })
  const handle = wrapper.get("[data-move-controls]")
  const toolbar = handle.element.parentElement!
  size(toolbar, { offsetWidth: 200, offsetHeight: 40 })
  vi.spyOn(handle.element, "setPointerCapture").mockImplementation(() => {})

  await handle.trigger("keydown", { key: "ArrowLeft" })
  expect([toolbar.style.left, toolbar.style.top]).toEqual(["572px", "12px"])

  await handle.trigger("pointerdown", { button: 0, pointerId: 1, clientX: 600, clientY: 20 })
  await handle.trigger("pointermove", { pointerId: 1, clientX: -400, clientY: 520 })
  await handle.trigger("pointerup", { pointerId: 1 })
  expect([toolbar.style.left, toolbar.style.top]).toEqual(["12px", "512px"])
  await handle.trigger("pointermove", { pointerId: 1, clientX: 300, clientY: 300 })
  expect(toolbar.style.left).toBe("12px")

  expect(wrapper.get('[role="dialog"]').classes()).toEqual(expect.arrayContaining(["bottom-full", "left-0"]))
})

test("control is opt-in and can pause with held keys released while video stays connected", async () => {
  const wrapper = await mountDesktop()
  const checkbox = wrapper.get("[data-desktop-control]")
  expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  await checkbox.setValue(true)
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  expect(mock.api.start).toHaveBeenCalledWith(expect.objectContaining({ control: true }))
  expect(checkbox.attributes("disabled")).toBeDefined()
  const video = wrapper.get("video")
  expect(video.attributes("tabindex")).toBe("0")
  await video.trigger("keydown", { code: "ControlLeft" })
  await button(wrapper, "Pause control").trigger("click")
  expect(peer.input.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "releaseAll" }))
  expect(video.attributes("tabindex")).toBe("-1")
  expect(peer.close).not.toHaveBeenCalled()
  await button(wrapper, "Resume control").trigger("click")
  expect(video.attributes("tabindex")).toBe("0")
})
