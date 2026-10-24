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

test("discovers displays without capturing, then connects with the selected settings", async () => {
  const wrapper = await mountDesktop()
  expect(wrapper.get('[role="status"]').text()).toBe("Choose a display and connect to start sharing.")
  const [display, codec] = wrapper.findAll("select")
  expect(codec!.findAll("option").map((option) => option.text())).toEqual(["H264", "H265", "AV1"])
  expect(codec!.element.value).toBe("h264")
  expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  expect(mock.api.offer).not.toHaveBeenCalled()
  expect(mock.api.start).not.toHaveBeenCalled()

  await display!.setValue("2")
  await codec!.setValue("av1")
  await wrapper.get('input[type="checkbox"]').setValue(true)
  await button(wrapper, "Connect").trigger("click")
  await flushPromises()
  expect(mock.api.offer).toHaveBeenCalledWith(expect.objectContaining({ codec: "av1", audio: true }))
  expect(wrapper.get('[role="status"]').text()).toBe("Connecting…")
  expect(button(wrapper, "Disconnect").exists()).toBe(true)
  expect(display!.attributes("disabled")).toBeDefined()

  const peer = TestPeer.instances[0]!
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack
  peer.ontrack?.({ track })
  peer.changeState("connected")
  await flushPromises()
  expect(mock.api.start).toHaveBeenCalledWith(expect.objectContaining({ displayId: 2 }))
  expect(wrapper.get('[role="status"]').text()).toBe("Connected")
  expect((wrapper.get("video").element as HTMLVideoElement).srcObject).toBeTruthy()
  expect(button(wrapper, "Full screen").exists()).toBe(true)
  await button(wrapper, "Disconnect").trigger("click")
  await flushPromises()
  expect((wrapper.get("video").element as HTMLVideoElement).srcObject).toBeNull()
  expect(track.stop).toHaveBeenCalledTimes(1)
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

  mock.api.capabilities.mockResolvedValueOnce({ displays: [], codecs: ["h264"], audio: false })
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
