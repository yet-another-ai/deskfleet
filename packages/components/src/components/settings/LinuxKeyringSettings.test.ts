import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import LinuxKeyringSettings from "./LinuxKeyringSettings.vue"

const host = getClient()
const getLinuxKeyring = vi.fn()
const setLinuxKeyring = vi.fn()
const restart = vi.fn()
let wrapper: VueWrapper | undefined

beforeEach(() => {
  getLinuxKeyring.mockReset().mockResolvedValue({ useSystemKeyring: true, restartRequired: false })
  setLinuxKeyring.mockReset().mockImplementation(async (useSystemKeyring: boolean) => ({
    useSystemKeyring,
    restartRequired: !useSystemKeyring,
  }))
  restart.mockReset().mockResolvedValue(undefined)
  configureClient({
    ...host,
    platform: "linux",
    application: { restart },
    settings: { ...host.settings, getLinuxKeyring, setLinuxKeyring },
  })
  i18n.global.locale.value = "en-US"
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  configureClient(host)
  i18n.global.locale.value = "en-US"
})

async function render() {
  wrapper = mount(LinuxKeyringSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

test("hides the keyring control on non-Linux hosts", async () => {
  configureClient({ ...host, platform: "darwin" })
  const view = await render()
  expect(view.find('[role="switch"]').exists()).toBe(false)
  expect(getLinuxKeyring).not.toHaveBeenCalled()
})

test("toggling system keyring persists the preference and offers an inline restart button", async () => {
  const view = await render()
  const toggle = view.get('[role="switch"]')
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(view.find("button.ui-button").exists()).toBe(false)

  await toggle.trigger("click")
  await flushPromises()
  expect(setLinuxKeyring).toHaveBeenCalledExactlyOnceWith(false)
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.get('[role="status"]').text()).toBe("Restart DeskFleet to apply")

  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(restart).toHaveBeenCalledOnce()
})

test("surfaces load failures with retry and write failures inline", async () => {
  getLinuxKeyring.mockRejectedValueOnce(new Error("Could not read keyring preference"))
  const view = await render()
  expect(view.get('[role="alert"]').text()).toContain("Could not read keyring preference")
  await view.get("button.ui-button").trigger("click")
  await flushPromises()
  expect(getLinuxKeyring).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)

  setLinuxKeyring.mockRejectedValueOnce(new Error("Disk full"))
  await view.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain("Disk full")
})
