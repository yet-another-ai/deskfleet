import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { LocalAgentState } from "../../../../client/src/local-agent.ts"
import { i18n } from "../../i18n/index.ts"
import LocalAgentSettings from "./LocalAgentSettings.vue"

let wrapper: VueWrapper | undefined
let changed: (state: LocalAgentState) => void
const unsubscribe = vi.fn()
const running: LocalAgentState = { enabled: true, status: "running" }
const stopped: LocalAgentState = { enabled: false, status: "stopped" }

const switchLabel = (view: VueWrapper) => view.get(`#${view.get('[role="switch"]').attributes("aria-labelledby")}`).text()

function render() {
  wrapper = mount(LocalAgentSettings, { global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  unsubscribe.mockClear()
  vi.spyOn(platformClient.settings, "get").mockResolvedValue(running)
  vi.spyOn(platformClient.settings, "onChanged").mockImplementation(listener => {
    changed = listener
    return unsubscribe
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("loads the saved preference before enabling changes and follows start progress", async () => {
  let loaded!: (state: LocalAgentState) => void
  vi.mocked(platformClient.settings.get).mockReturnValue(new Promise(resolve => { loaded = resolve }))
  let started!: (state: LocalAgentState) => void
  const save = vi.spyOn(platformClient.settings, "setLocalAgentEnabled").mockReturnValue(new Promise(resolve => { started = resolve }))
  const view = render()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  expect(save).not.toHaveBeenCalled()
  loaded(stopped)
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("false")
  await view.get('[role="switch"]').trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith(true)
  expect(view.get('[role="switch"]').attributes("disabled")).toBeDefined()
  changed({ enabled: true, status: "starting" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Starting…")
  changed(running)
  started(running)
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Running")
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
})

test("turns off directly, describes its effect on terminals, and retains state after a rejected write", async () => {
  const save = vi.spyOn(platformClient.settings, "setLocalAgentEnabled").mockRejectedValueOnce(new Error("Could not save settings"))
  const view = render()
  await flushPromises()
  expect(view.get(`#${view.get('[role="switch"]').attributes("aria-describedby")}`).text()).toBe("Turning it off also stops its terminals.")
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(false)
  expect(view.get('[role="alert"]').text()).toBe("Could not save settings")
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  save.mockResolvedValueOnce(stopped)
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("false")
  expect(view.get('[role="status"]').text()).toBe("Stopped")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([true, false])("retries a failed runtime operation with enabled=%s and unsubscribes on exit", async (enabled) => {
  vi.mocked(platformClient.settings.get).mockResolvedValue({ enabled, status: "error", error: "Daemon operation failed" })
  const save = vi.spyOn(platformClient.settings, "setLocalAgentEnabled").mockResolvedValue(enabled ? running : stopped)
  const view = render()
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Daemon operation failed")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith(enabled)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  view.unmount()
  wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("reloads a failed initial read and preserves a newer event while the read is pending", async () => {
  vi.mocked(platformClient.settings.get).mockRejectedValueOnce(new Error("Settings unavailable"))
  const view = render()
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("disabled")).toBeDefined()
  expect(view.get('[role="alert"]').text()).toBe("Settings unavailable")
  expect(view.get('[role="status"]').text()).toBe("Settings unavailable")
  let loaded!: (state: LocalAgentState) => void
  vi.mocked(platformClient.settings.get).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  await view.get("button.ui-button").trigger("click")
  changed(running)
  loaded(stopped)
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.get('[role="status"]').text()).toBe("Running")
})

test("localizes settings and explains an independently started Agent", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  vi.mocked(platformClient.settings.get).mockResolvedValue({ enabled: false, status: "running" })
  const view = render()
  await flushPromises()
  expect(switchLabel(view)).toBe("运行本地 Agent")
  expect(view.get('[role="status"]').text()).toBe("在外部运行")
})

test("groups independent screen and input permission changes without changing Agent availability", async () => {
  vi.mocked(platformClient.settings.get).mockResolvedValue({ ...running, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  const view = render()
  await flushPromises()
  expect(view.get('[data-screen-capture-permission="requesting"]').text()).toBe("Requesting access to record the screen and system audio…")
  expect(view.get('[data-desktop-permissions] [data-accessibility-permission="requesting"]').text()).toBe("Requesting Accessibility access for mouse and keyboard control…")
  expect(view.get('[data-desktop-permissions]').attributes("aria-label")).toBe("Desktop permissions")
  expect(view.get('span[role="status"]').text()).toBe("Running")

  changed({ ...running, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } })
  await flushPromises()
  expect(view.get('[data-screen-capture-permission="denied"][role="alert"]').text()).toBe("Allow access in macOS System Settings → Privacy & Security → Screen & System Audio Recording, then turn the local Agent off and on.")
  expect(view.get('[role="status"]').text()).toBe("Running")
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  expect(view.find("[data-accessibility-permission]").exists()).toBe(false)

  changed({ ...running, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
  await flushPromises()
  expect(view.find("[data-screen-capture-permission]").exists()).toBe(false)
  expect(view.get('[data-accessibility-permission="denied"][role="alert"]').text()).toBe("Allow mouse and keyboard control in macOS System Settings → Privacy & Security → Accessibility, then turn the local Agent off and on.")
  expect(view.get('span[role="status"]').text()).toBe("Running")
  changed({ ...running, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "granted" } })
  await flushPromises()
  expect(view.find("[data-desktop-permissions]").exists()).toBe(false)
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each(["en-US", "zh-cmn-Hans-CN"] as const)("shows automatic Full Disk Access status and system settings instructions in %s", async locale => {
  i18n.global.locale.value = locale
  vi.mocked(platformClient.settings.get).mockResolvedValue({ ...running, fullDiskAccessPermission: { status: "requesting" } })
  const view = render()
  await flushPromises()
  expect(view.get('[data-full-disk-access-permission="requesting"][role="status"]').text()).toBe(i18n.global.t("settings.fullDiskAccessRequesting"))
  changed({ ...running, fullDiskAccessPermission: { status: "denied" } })
  await flushPromises()
  expect(view.get('[data-full-disk-access-permission="denied"][role="alert"]').text()).toBe(locale === "en-US"
    ? "Grant Full Disk Access to the app or executable running the local Agent in macOS System Settings → Privacy & Security → Full Disk Access, then restart that app or executable."
    : "请在 macOS 系统设置 → 隐私与安全性 → 完全磁盘访问权限中，授权运行本地 Agent 的应用或可执行文件，然后重新启动该应用或可执行文件。")
  expect(view.find("button.ui-button").exists()).toBe(false)
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  changed({ ...running, fullDiskAccessPermission: { status: "granted" } })
  await flushPromises()
  expect(view.find("[data-desktop-permissions]").exists()).toBe(false)
})

test.each(["response", "error"])("preserves a newer permission event when the pending start returns a stale %s", async result => {
  vi.mocked(platformClient.settings.get).mockResolvedValue(stopped)
  let started!: (state: LocalAgentState) => void
  let failed!: (error: Error) => void
  vi.spyOn(platformClient.settings, "setLocalAgentEnabled").mockReturnValue(new Promise((resolve, reject) => { started = resolve; failed = reject }))
  const view = render()
  await flushPromises()
  await view.get('[role="switch"]').trigger("click")
  changed({ ...running, status: "starting" })
  changed({ ...running, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  changed({ ...running, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "granted" } })
  if (result === "response") started({ ...running, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  else failed(new Error("Stale start response failed"))
  await flushPromises()
  expect(view.find("[data-screen-capture-permission]").exists()).toBe(false)
  expect(view.find("[data-accessibility-permission]").exists()).toBe(false)
  expect(view.get('span[role="status"]').text()).toBe("Running")
  expect(view.get('[role="switch"]').attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each(["granted", "not-required", "checking"] as const)("hides normal desktop permission status %s and notices when the Agent stops", async status => {
  vi.mocked(platformClient.settings.get).mockResolvedValue({ ...running, fullDiskAccessPermission: { status }, screenCapturePermission: { status }, accessibilityPermission: { status } })
  const view = render()
  await flushPromises()
  expect(view.find("[data-screen-capture-permission]").exists()).toBe(false)
  expect(view.find("[data-accessibility-permission]").exists()).toBe(false)
  expect(view.find("[data-full-disk-access-permission]").exists()).toBe(false)
  changed({ ...running, fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  await flushPromises()
  expect(view.find("[data-screen-capture-permission]").exists()).toBe(true)
  expect(view.find("[data-accessibility-permission]").exists()).toBe(true)
  expect(view.find("[data-full-disk-access-permission]").exists()).toBe(true)
  changed({ ...stopped, fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  await flushPromises()
  expect(view.find("[data-screen-capture-permission]").exists()).toBe(false)
  expect(view.find("[data-accessibility-permission]").exists()).toBe(false)
  expect(view.find("[data-full-disk-access-permission]").exists()).toBe(false)
  expect(view.get('[role="status"]').text()).toBe("Stopped")
})

test("localizes permission errors and shows native errors separately from Agent health", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  vi.mocked(platformClient.settings.get).mockResolvedValue({ ...running, fullDiskAccessPermission: { status: "error", error: "Full Disk Access request failed" }, screenCapturePermission: { status: "error", error: "Capture request failed" }, accessibilityPermission: { status: "error", error: "Accessibility request failed" } })
  const view = render()
  await flushPromises()
  const notice = view.get('[data-screen-capture-permission="error"][role="alert"]')
  expect(notice.text()).toContain("无法请求屏幕与系统音频录制权限。请关闭并重新开启本地 Agent 以重试。")
  expect(notice.text()).toContain("Capture request failed")
  const accessibility = view.get('[data-accessibility-permission="error"][role="alert"]')
  expect(accessibility.text()).toContain("无法请求用于鼠标和键盘控制的辅助功能权限。请关闭并重新开启本地 Agent 以重试。")
  expect(accessibility.text()).toContain("Accessibility request failed")
  const fullDiskAccess = view.get('[data-full-disk-access-permission="error"][role="alert"]')
  expect(fullDiskAccess.text()).toContain("无法请求完全磁盘访问权限。请重新启动运行本地 Agent 的应用或可执行文件以重试。")
  expect(fullDiskAccess.text()).toContain("Full Disk Access request failed")
  expect(view.get('[role="status"]').text()).toBe("运行中")
  expect(view.find("button.ui-button").exists()).toBe(false)
})
