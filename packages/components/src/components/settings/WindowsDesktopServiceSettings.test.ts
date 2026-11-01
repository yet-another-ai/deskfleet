import { configureClient, getClient } from "@deskfleet/client/platform"
import type { WindowsDesktopServiceApi, WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import WindowsDesktopServiceSettings from "./WindowsDesktopServiceSettings.vue"

const host = getClient()
const get = vi.fn<WindowsDesktopServiceApi["get"]>()
const setEnabled = vi.fn<WindowsDesktopServiceApi["setEnabled"]>()
const disabled = { available: true, installed: false, running: false }
const enabled = { available: true, installed: true, running: true }
let wrapper: VueWrapper | undefined

beforeEach(() => {
  get.mockReset().mockResolvedValue(disabled)
  setEnabled.mockReset().mockResolvedValue(enabled)
  configureClient({ ...host, platform: "win32", windowsDesktopService: { get, setEnabled } })
  i18n.global.locale.value = "en-US"
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  configureClient(host)
  i18n.global.locale.value = "en-US"
})

async function render() {
  wrapper = mount(WindowsDesktopServiceSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

test("opening settings and regaining focus only read Windows service status", async () => {
  const view = await render()
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("false")
  expect(view.text()).toContain("administrator approval")
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(get).toHaveBeenCalledTimes(2)
  expect(setEnabled).not.toHaveBeenCalled()
})

test("the switch waits for administrator approval and uses the confirmed service state", async () => {
  let finish!: (state: WindowsDesktopServiceState) => void
  setEnabled.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = await render()
  const toggle = view.get('[role="switch"]')
  await toggle.trigger("click")
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(toggle.attributes("aria-checked")).toBe("false")
  window.dispatchEvent(new Event("focus"))
  expect(get).toHaveBeenCalledTimes(1)
  finish(enabled)
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(toggle.attributes("disabled")).toBeUndefined()
})

test("cancelling removal preserves the enabled state and permits retry", async () => {
  get.mockResolvedValue(enabled)
  setEnabled.mockRejectedValueOnce(new Error("Administrator approval was cancelled"))
  const view = await render()
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false)
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.get('[role="alert"]').text()).toContain("cancelled")
  setEnabled.mockResolvedValueOnce(disabled)
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(view.get('[role="switch"]').attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("an installed stopped service can be started without first removing it", async () => {
  get.mockResolvedValue({ ...enabled, running: false })
  const view = await render()
  expect(view.get('[role="status"]').text()).toBe("Installed, but not running")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(view.find("button.ui-button").exists()).toBe(false)
})

test("hosts without the Windows setup API show no control", async () => {
  configureClient(host)
  const view = await render()
  expect(view.find('[role="switch"]').exists()).toBe(false)
  expect(get).not.toHaveBeenCalled()
})
