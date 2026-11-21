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
  vi.spyOn(platformClient.settings, "getAutoDownloadUpdates").mockResolvedValue({ enabled: true, pauseOnMetered: true, installSource: "desktop_installer" })
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
  loaded({ enabled: true, pauseOnMetered: true, installSource: "desktop_installer" })
  await flushPromises()
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(toggle.attributes("aria-checked")).toBe("true")
  await toggle.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  saved({ enabled: false, pauseOnMetered: true, installSource: "desktop_installer" })
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test("preserves the setting after a rejected change and allows updating on retry", async () => {
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockResolvedValue({ enabled: true, pauseOnMetered: true, installSource: "desktop_installer" })
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
  save.mockResolvedValueOnce({ enabled: false, pauseOnMetered: true, installSource: "desktop_installer" })
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

test("shows the metered-network preference only while automatic downloads are enabled", async () => {
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockResolvedValue({ enabled: false, pauseOnMetered: false, installSource: "desktop_installer" })
  const save = vi.spyOn(platformClient.settings, "setAutoDownloadUpdates")
  const view = render()
  await flushPromises()
  const meteredSelector = '[role="switch"][aria-labelledby="pause-updates-on-metered-label"]'
  expect(view.find(meteredSelector).exists()).toBe(false)
  save.mockResolvedValueOnce({ enabled: true, pauseOnMetered: false, installSource: "desktop_installer" })
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(view.get(meteredSelector).attributes("aria-checked")).toBe("false")
  save.mockResolvedValueOnce({ enabled: false, pauseOnMetered: false, installSource: "desktop_installer" })
  await view.get('[role="switch"][aria-labelledby="auto-download-updates-label"]').trigger("click")
  await flushPromises()
  expect(view.find(meteredSelector).exists()).toBe(false)
})

test("waits for confirmation when saving the metered-network preference", async () => {
  let saved!: (state: AutoDownloadUpdatesState) => void
  const save = vi.spyOn(platformClient.settings, "setPauseUpdatesOnMetered").mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"][aria-labelledby="pause-updates-on-metered-label"]')
  expect(toggle.attributes("aria-checked")).toBe("true")
  await toggle.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(view.findAll('[role="switch"]').every(control => control.attributes("disabled") !== undefined)).toBe(true)
  saved({ enabled: true, pauseOnMetered: false, installSource: "desktop_installer" })
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test("keeps the saved metered-network preference after a failed change", async () => {
  const save = vi.spyOn(platformClient.settings, "setPauseUpdatesOnMetered").mockRejectedValueOnce(new Error("Could not save metered preference"))
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"][aria-labelledby="pause-updates-on-metered-label"]')
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(view.get('[role="alert"]').text()).toBe("Could not save metered preference")
  save.mockResolvedValueOnce({ enabled: true, pauseOnMetered: false, installSource: "desktop_installer" })
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([
  ["en-US", "Pause on metered networks"],
  ["zh-cmn-Hans-CN", "在计费网络中自动暂停"],
  ["ja-JP", "従量制課金ネットワークで自動的に一時停止"],
] as const)("labels the metered-network preference in %s", async (locale, label) => {
  i18n.global.locale.value = locale
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"][aria-labelledby="pause-updates-on-metered-label"]')
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe(label)
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).not.toContain("settings.")
})

test.each([
  ["en-US", "Automatically download updates", "Download new versions in the background so they are ready to install."],
  ["zh-cmn-Hans-CN", "自动下载更新", "在后台自动下载新版本，随时可供安装。"],
] as const)("explains the background download behavior in %s", async (locale, label, description) => {
  i18n.global.locale.value = locale
  const view = render()
  await flushPromises()
  const toggle = view.get('[role="switch"]')
  expect(view.get(`#${toggle.attributes("aria-labelledby")}`).text()).toBe(label)
  expect(view.get(`#${toggle.attributes("aria-describedby")}`).text()).toBe(description)
})

test("toggles install-on-quit on desktop and hides it when absent", async () => {
  const selector = '[role="switch"][aria-labelledby="install-updates-on-quit-label"]'
  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockResolvedValueOnce({ enabled: true, pauseOnMetered: true, installSource: "google_play" })
  const mobileView = render()
  await flushPromises()
  expect(mobileView.find(selector).exists()).toBe(false)
  mobileView.unmount()

  vi.mocked(platformClient.settings.getAutoDownloadUpdates).mockResolvedValueOnce({ enabled: true, pauseOnMetered: true, installOnQuit: true, installSource: "desktop_installer" })
  const save = vi.spyOn(platformClient.settings, "setInstallUpdatesOnQuit").mockResolvedValueOnce({ enabled: true, pauseOnMetered: true, installOnQuit: false, installSource: "desktop_installer" })
  const view = render()
  await flushPromises()
  const toggle = view.get(selector)
  expect(toggle.attributes("aria-checked")).toBe("true")
  await toggle.trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("false")
})
