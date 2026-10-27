import { client, configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { NotificationSettings } from "../../../../client/src/settings.ts"
import { getBrowserNotificationPermission, requestBrowserNotificationPermission } from "@deskfleet/client/browser-notifications"
import { i18n } from "../../i18n/index.ts"
import NotificationsSettings from "./NotificationsSettings.vue"

vi.mock("@deskfleet/client/browser-notifications", () => ({
  getBrowserNotificationPermission: vi.fn(() => "default"),
  requestBrowserNotificationPermission: vi.fn(async () => "granted"),
}))

const host = getClient()
const enabled: NotificationSettings = { enabled: true, taskCompleted: true, taskNeedsInput: true }
let wrapper: VueWrapper | undefined
function render() {
  wrapper = mount(NotificationsSettings, { global: { plugins: [i18n] } })
  return wrapper
}
const toggle = (key: keyof NotificationSettings) => wrapper!.get(`[role="switch"][aria-labelledby="notifications-${key}-label"]`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBrowserNotificationPermission).mockReturnValue("default")
  vi.mocked(requestBrowserNotificationPermission).mockResolvedValue("granted")
  vi.spyOn(client.settings, "getNotifications").mockResolvedValue({ ...enabled })
  vi.spyOn(client.settings, "setNotifications").mockImplementation(async settings => settings)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  configureClient(host)
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("waits for settings and saved values before enabling changes", async () => {
  let loaded!: (settings: NotificationSettings) => void
  vi.mocked(client.settings.getNotifications).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  let saved!: (settings: NotificationSettings) => void
  vi.mocked(client.settings.setNotifications).mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  expect(view.findAll('[role="switch"]').every(control => control.attributes("disabled") !== undefined)).toBe(true)
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  loaded(enabled)
  await flushPromises()
  await toggle("taskCompleted").trigger("click")
  expect(client.settings.setNotifications).toHaveBeenCalledExactlyOnceWith({ ...enabled, taskCompleted: false })
  expect(view.findAll('[role="switch"]').every(control => control.attributes("disabled") !== undefined)).toBe(true)
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  saved(enabled)
  await flushPromises()
  expect(toggle("taskCompleted").attributes("aria-checked")).toBe("true")
  expect(toggle("taskCompleted").attributes("disabled")).toBeUndefined()
})

test("preserves independent event choices while desktop notifications are off", async () => {
  render()
  await flushPromises()
  await toggle("taskCompleted").trigger("click")
  await flushPromises()
  expect(toggle("taskCompleted").attributes("aria-checked")).toBe("false")
  expect(toggle("taskNeedsInput").attributes("aria-checked")).toBe("true")
  await toggle("enabled").trigger("click")
  await flushPromises()
  expect(client.settings.setNotifications).toHaveBeenLastCalledWith({ enabled: false, taskCompleted: false, taskNeedsInput: true })
  expect(toggle("taskCompleted").attributes("disabled")).toBeDefined()
  expect(toggle("taskNeedsInput").attributes("disabled")).toBeDefined()
  await toggle("taskNeedsInput").trigger("click")
  expect(client.settings.setNotifications).toHaveBeenCalledTimes(2)
  await toggle("enabled").trigger("click")
  await flushPromises()
  expect(toggle("taskCompleted").attributes("aria-checked")).toBe("false")
  expect(toggle("taskNeedsInput").attributes("aria-checked")).toBe("true")
  expect(toggle("taskCompleted").attributes("disabled")).toBeUndefined()
  await toggle("taskNeedsInput").trigger("click")
  await flushPromises()
  expect(client.settings.setNotifications).toHaveBeenLastCalledWith({ enabled: true, taskCompleted: false, taskNeedsInput: false })
})

test("preserves previous choices after a save fails and allows retry", async () => {
  vi.mocked(client.settings.setNotifications).mockRejectedValueOnce(new Error("Could not save notifications"))
  const view = render()
  await flushPromises()
  await toggle("enabled").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Could not save notifications")
  expect(toggle("enabled").attributes("aria-checked")).toBe("true")
  expect(toggle("taskCompleted").attributes("disabled")).toBeUndefined()
  await toggle("enabled").trigger("click")
  await flushPromises()
  expect(toggle("enabled").attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("offers a reload after the initial read fails", async () => {
  vi.mocked(client.settings.getNotifications).mockRejectedValueOnce(new Error("Notifications unavailable"))
  const view = render()
  await flushPromises()
  expect(toggle("enabled").attributes("disabled")).toBeDefined()
  expect(view.get('[role="alert"]').text()).toBe("Notifications unavailable")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(toggle("enabled").attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([
  ["en-US", "Notifications", "Desktop notifications", "Task completed", "Task needs input"],
  ["zh-cmn-Hans-CN", "通知", "桌面通知", "任务完成", "任务需要回应"],
] as const)("provides named and described controls in %s", async (locale, heading, ...labels) => {
  i18n.global.locale.value = locale
  const view = render()
  await flushPromises()
  expect(view.get("h1").text()).toBe(heading)
  const controls = view.findAll('[role="switch"]')
  expect(controls.map(control => view.get(`#${control.attributes("aria-labelledby")}`).text())).toEqual(labels)
  for (const control of controls) expect(view.get(`#${control.attributes("aria-describedby")}`).text()).not.toBe("")
})

test("browser settings show preferences and request permission only from the enable button", async () => {
  configureClient({ ...host, platform: "web" })
  const view = render()
  await flushPromises()
  expect(client.settings.getNotifications).toHaveBeenCalledOnce()
  expect(view.findAll('[role="switch"]')).toHaveLength(3)
  expect(view.text()).toContain("Browser notifications")
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  await toggle("taskCompleted").trigger("click")
  await flushPromises()
  expect(client.settings.setNotifications).toHaveBeenLastCalledWith({ ...enabled, taskCompleted: false })
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  await view.findAll("button").find(button => button.text() === "Enable notifications")!.trigger("click")
  await flushPromises()
  expect(requestBrowserNotificationPermission).toHaveBeenCalledOnce()
  expect(view.get('[role="status"]').text()).toBe("Notifications are allowed in this browser.")
})

test.each(["denied", "unsupported"] as const)("browser %s permission remains separate from notification preferences", async permission => {
  configureClient({ ...host, platform: "web" })
  vi.mocked(getBrowserNotificationPermission).mockReturnValue(permission)
  const view = render()
  await flushPromises()
  expect(view.findAll("button").some(button => button.text() === "Enable notifications")).toBe(false)
  expect(view.get('[role="status"]').text()).toContain(permission === "denied" ? "browser’s site settings" : "unavailable")
  await toggle("enabled").trigger("click")
  await flushPromises()
  expect(client.settings.setNotifications).toHaveBeenLastCalledWith({ ...enabled, enabled: false })
  expect(requestBrowserNotificationPermission).not.toHaveBeenCalled()
  vi.mocked(getBrowserNotificationPermission).mockReturnValue("granted")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Notifications are allowed in this browser.")
})

test("browser permission request failures can be retried", async () => {
  configureClient({ ...host, platform: "web" })
  vi.mocked(requestBrowserNotificationPermission).mockRejectedValueOnce(new Error("Permission request failed"))
  const view = render()
  await flushPromises()
  const enable = () => view.findAll("button").find(button => button.text() === "Enable notifications")!
  await enable().trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Permission request failed")
  await enable().trigger("click")
  await flushPromises()
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.get('[role="status"]').text()).toBe("Notifications are allowed in this browser.")
})
