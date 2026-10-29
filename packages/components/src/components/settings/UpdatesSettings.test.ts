import { configureClient, getClient } from "@deskfleet/client/platform"
import type { UpdateApi, UpdateState } from "@deskfleet/client/updates"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import UpdatesSettings from "./UpdatesSettings.vue"

const host = getClient()
const get = vi.fn<UpdateApi["get"]>()
const check = vi.fn<UpdateApi["check"]>()
const install = vi.fn<UpdateApi["install"]>()
const unsubscribe = vi.fn()
let publish: (state: UpdateState) => void
let wrapper: VueWrapper | undefined

beforeEach(() => {
  get.mockReset().mockResolvedValue({ status: "idle", currentVersion: "0.1.0" })
  check.mockReset().mockResolvedValue({ status: "idle", currentVersion: "0.1.0" })
  install.mockReset().mockResolvedValue(undefined)
  unsubscribe.mockReset()
  configureClient({ ...host, updates: { get, check, install, onChanged: listener => { publish = listener; return unsubscribe } } })
  i18n.global.locale.value = "en-US"
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  configureClient(host)
  i18n.global.locale.value = "en-US"
})

async function render() {
  wrapper = mount(UpdatesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

test("shows the installed version and reads current state without checking or installing", async () => {
  const view = await render()
  expect(view.text()).toContain("0.1.0")
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.ready"))
  expect(view.get("button").text()).toBe(i18n.global.t("updatesSettings.check"))
  expect(get).toHaveBeenCalledOnce()
  expect(check).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
})

test("checks only after a click, prevents duplicate clicks, and confirms no update is available", async () => {
  let finish!: (value: UpdateState) => void
  check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = await render()
  await view.get("button").trigger("click")
  expect(check).toHaveBeenCalledOnce()
  expect(view.get('[role="status"]').text()).toBe("Checking for updates…")
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(true)
  await view.get("button").trigger("click")
  expect(check).toHaveBeenCalledOnce()
  finish({ status: "idle", currentVersion: "0.1.0" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.upToDate"))
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(false)
  expect(install).not.toHaveBeenCalled()
})

test("offers an available version and waits for install consent before showing download and restart progress", async () => {
  check.mockImplementationOnce(async () => {
    const state: UpdateState = { status: "available", version: "0.2.0", currentVersion: "0.1.0" }
    publish(state)
    return state
  })
  const view = await render()
  await view.get("button").trigger("click")
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Version 0.2.0 is available")
  expect(install).not.toHaveBeenCalled()
  const installButton = view.findAll("button")[1]!
  await installButton.trigger("click")
  expect(install).toHaveBeenCalledOnce()
  publish({ status: "downloading", version: "0.2.0", percent: 42.8, currentVersion: "0.1.0" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Downloading 42%")
  expect(view.findAll<HTMLButtonElement>("button").every(button => button.element.disabled)).toBe(true)
  await installButton.trigger("click")
  expect(install).toHaveBeenCalledOnce()
  publish({ status: "installing", version: "0.2.0", currentVersion: "0.1.0" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Restarting…")
  expect(view.findAll<HTMLButtonElement>("button").every(button => button.element.disabled)).toBe(true)
})

test("a failed check can be retried without offering installation or claiming the app is up to date", async () => {
  check.mockRejectedValueOnce(new Error("Offline"))
  const view = await render()
  await view.get("button").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe(i18n.global.t("updatesSettings.checkFailed"))
  expect(view.get('[role="alert"]').attributes("title")).toBe("Offline")
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.ready"))
  expect(view.findAll("button")).toHaveLength(1)
  expect(install).not.toHaveBeenCalled()
  await view.get("button").trigger("click")
  await flushPromises()
  expect(check).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.upToDate"))
  check.mockRejectedValueOnce(new Error("Offline again"))
  await view.get("button").trigger("click")
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.ready"))
  expect(view.get('[role="alert"]').attributes("title")).toBe("Offline again")
})

test("installation failure retains the available version, offers retry, and translates live", async () => {
  get.mockResolvedValue({ status: "available", version: "0.2.0", currentVersion: "0.1.0" })
  install.mockRejectedValueOnce(new Error("Download interrupted"))
  const view = await render()
  await view.findAll("button")[1]!.trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').attributes("title")).toBe("Download interrupted")
  expect(view.findAll("button")[1]!.text()).toBe("Retry update")
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await flushPromises()
  expect(view.get("h1").text()).toBe(i18n.global.t("updatesSettings.title"))
  expect(view.get('[role="status"]').text()).toBe("新版本 0.2.0 已可用")
  expect(view.findAll("button")[1]!.text()).toBe("重试更新")
  await view.findAll("button")[1]!.trigger("click")
  expect(install).toHaveBeenCalledTimes(2)
})

test("new events win over older initial and manual check snapshots and unsubscribe on unmount", async () => {
  let finishGet!: (value: UpdateState) => void
  get.mockImplementationOnce(() => new Promise(resolve => { finishGet = resolve }))
  const view = await render()
  publish({ status: "available", version: "0.2.0" })
  finishGet({ status: "idle" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Version 0.2.0 is available")
  let finishCheck!: (value: UpdateState) => void
  check.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve }))
  await view.get("button").trigger("click")
  publish({ status: "downloading", version: "0.3.0", percent: 20 })
  finishCheck({ status: "idle" })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toBe("Downloading 20%")
  view.unmount()
  wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("reports disabled builds without allowing a check", async () => {
  get.mockResolvedValue({ status: "disabled", currentVersion: "0.1.0" })
  const view = await render()
  expect(view.get('[role="status"]').text()).toBe(i18n.global.t("updatesSettings.unavailable"))
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(true)
  await view.get("button").trigger("click")
  expect(check).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
})

test("retries an unavailable initial snapshot without checking for or installing an update", async () => {
  get.mockRejectedValueOnce(new Error("IPC interrupted"))
  const view = await render()
  expect(view.get('[role="alert"]').text()).toBe("IPC interrupted")
  expect(view.get("button").text()).toBe("Reload settings")
  await view.get("button").trigger("click")
  await flushPromises()
  expect(get).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.text()).toContain("0.1.0")
  expect(check).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
})
