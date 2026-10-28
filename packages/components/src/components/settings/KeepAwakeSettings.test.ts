import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { KeepAwakeState } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import KeepAwakeSettings from "./KeepAwakeSettings.vue"

let wrapper: VueWrapper | undefined

function render() {
  wrapper = mount(KeepAwakeSettings, { global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  vi.spyOn(platformClient.settings, "getKeepAwake").mockResolvedValue({ enabled: false })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("waits for the saved setting and reflects the confirmed result after saving", async () => {
  let loaded!: (state: KeepAwakeState) => void
  vi.mocked(platformClient.settings.getKeepAwake).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  let saved!: (state: KeepAwakeState) => void
  const save = vi.spyOn(platformClient.settings, "setKeepAwake").mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  loaded({ enabled: false })
  await flushPromises()
  expect(toggle.attributes("disabled")).toBeUndefined()
  await toggle.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  saved({ enabled: true })
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test("preserves the setting after a rejected change and allows disabling on retry", async () => {
  vi.mocked(platformClient.settings.getKeepAwake).mockResolvedValue({ enabled: true })
  const save = vi.spyOn(platformClient.settings, "setKeepAwake").mockRejectedValueOnce(new Error("Could not save Keep Awake"))
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  await toggle.trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(view.get('[role="alert"]').text()).toBe("Could not save Keep Awake")
  save.mockResolvedValueOnce({ enabled: false })
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("offers a reload after the initial read fails", async () => {
  vi.mocked(platformClient.settings.getKeepAwake).mockRejectedValueOnce(new Error("Settings unavailable"))
  const view = render()
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeDefined()
  expect(view.get('[role="alert"]').text()).toBe("Settings unavailable")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([
  ["en-US", "Keep Awake", "Prevent idle sleep while DeskFleet is running, including in the tray. The display can still turn off."],
  ["zh-cmn-Hans-CN", "保持唤醒", "DeskFleet 运行时阻止本机因空闲而休眠，关闭到托盘后仍然有效。屏幕仍可自动关闭。"],
] as const)("explains the app lifetime and display behavior in %s", async (locale, label, description) => {
  i18n.global.locale.value = locale
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe(label)
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).toBe(description)
})
