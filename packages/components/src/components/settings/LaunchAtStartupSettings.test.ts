import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { LaunchAtStartupState } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import LaunchAtStartupSettings from "./LaunchAtStartupSettings.vue"

let wrapper: VueWrapper | undefined
const disabled: LaunchAtStartupState = { available: true, enabled: false }
const enabled: LaunchAtStartupState = { available: true, enabled: true }

function render() {
  wrapper = mount(LaunchAtStartupSettings, { global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  vi.spyOn(platformClient.settings, "getLaunchAtStartup").mockResolvedValue(disabled)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("waits for the OS setting before enabling changes and reflects the saved result", async () => {
  let loaded!: (state: LaunchAtStartupState) => void
  vi.mocked(platformClient.settings.getLaunchAtStartup).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  let saved!: (state: LaunchAtStartupState) => void
  const save = vi.spyOn(platformClient.settings, "setLaunchAtStartup").mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  expect(save).not.toHaveBeenCalled()
  loaded(disabled)
  await flushPromises()
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe("Launch at startup")
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).toBe("Open DeskFleet automatically when you log in.")
  await toggle.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  saved(disabled)
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test.each([false, true])("changes launch at startup from enabled=%s", async (initiallyEnabled) => {
  vi.mocked(platformClient.settings.getLaunchAtStartup).mockResolvedValue(initiallyEnabled ? enabled : disabled)
  const save = vi.spyOn(platformClient.settings, "setLaunchAtStartup").mockResolvedValue(initiallyEnabled ? disabled : enabled)
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("aria-checked")).toBe(String(initiallyEnabled))
  await toggle.trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(!initiallyEnabled)
  expect(toggle.attributes("aria-checked")).toBe(String(!initiallyEnabled))
})

test("preserves the previous setting after a rejected save and allows retry", async () => {
  vi.mocked(platformClient.settings.getLaunchAtStartup).mockResolvedValue(enabled)
  const save = vi.spyOn(platformClient.settings, "setLaunchAtStartup").mockRejectedValueOnce(new Error("Could not update login item"))
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  await toggle.trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(view.get('[role="alert"]').text()).toBe("Could not update login item")
  save.mockResolvedValueOnce(disabled)
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("offers a reload after the initial read fails", async () => {
  vi.mocked(platformClient.settings.getLaunchAtStartup).mockRejectedValueOnce(new Error("Login settings unavailable"))
  const view = render()
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeDefined()
  expect(view.get('[role="alert"]').text()).toBe("Login settings unavailable")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([
  ["en-US", "Launch at startup", "Available in the installed app on macOS and Windows."],
  ["zh-cmn-Hans-CN", "开机自启", "适用于 macOS 和 Windows 上已安装的应用。"],
] as const)("explains unavailable startup settings in %s", async (locale, label, description) => {
  i18n.global.locale.value = locale
  vi.mocked(platformClient.settings.getLaunchAtStartup).mockResolvedValue({ available: false, enabled: false })
  const save = vi.spyOn(platformClient.settings, "setLaunchAtStartup")
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe(label)
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).toBe(description)
  await toggle.trigger("click")
  expect(save).not.toHaveBeenCalled()
})
