import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AutoDownloadUpdatesState } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import AutoDownloadUpdatesSettings from "./AutoDownloadUpdatesSettings.vue"

let wrapper: VueWrapper | undefined

function render() {
  wrapper = mount(AutoDownloadUpdatesSettings, { global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  vi.spyOn(platformClient.settings, "getAutoDownloadUpdates").mockResolvedValue({ enabled: true, installSource: "desktop_installer" })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("waits for the saved setting and reflects the confirmed result after saving", async () => {
  let loaded!: (state: AutoDownloadUpdatesState) => void
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  let saved!: (state: AutoDownloadUpdatesState) => void
  const save = vi.spyOn(platformClient.settings, "setAutoDownloadUpdates").mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  loaded({ enabled: true, installSource: "desktop_installer" })
  await flushPromises()
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(toggle.attributes("aria-checked")).toBe("true")
  await toggle.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  saved({ enabled: false, installSource: "desktop_installer" })
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test("preserves the setting after a rejected change and allows updating on retry", async () => {
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockResolvedValue({ enabled: true, installSource: "desktop_installer" })
  const save = vi.spyOn(platformClient.settings, "setAutoDownloadUpdates").mockRejectedValueOnce(new Error("Could not save update preference"))
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  await toggle.trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(view.get('[role="alert"]').text()).toBe("Could not save update preference")
  save.mockResolvedValueOnce({ enabled: false, installSource: "desktop_installer" })
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("offers a reload after the initial read fails", async () => {
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockRejectedValueOnce(new Error("Settings unavailable"))
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
  ["en-US", "Automatically download updates", "Download new versions in the background and wait for your confirmation before installing and restarting."],
  ["zh-cmn-Hans-CN", "自动下载更新", "在后台自动下载新版本，并在安装和重启前等待你的确认。"],
] as const)("explains the background download and confirmation behavior in %s", async (locale, label, description) => {
  i18n.global.locale.value = locale
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe(label)
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).toBe(description)
})
