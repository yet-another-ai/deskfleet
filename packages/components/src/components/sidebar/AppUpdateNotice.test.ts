import { configureClient, getClient } from "@deskfleet/client/platform"
import type { UpdateApi, UpdateState } from "@deskfleet/client/updates"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import AccountShell from "../../AccountShell.vue"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { fakeCentral } from "../../test/central.ts"
import AppUpdateNotice from "./AppUpdateNotice.vue"

const host = getClient()
let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia> | undefined
let publish: (state: UpdateState) => void
let api: UpdateApi
const get = vi.fn<UpdateApi["get"]>()
const install = vi.fn<UpdateApi["install"]>()
const unsubscribe = vi.fn()

beforeEach(() => {
  get.mockReset().mockResolvedValue({ status: "available", version: "0.2.0" })
  install.mockReset().mockResolvedValue(undefined)
  unsubscribe.mockReset()
  api = { get, install, onChanged: listener => { publish = listener; return unsubscribe } }
  configureClient({ ...host, updates: api })
  i18n.global.locale.value = "en-US"
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  if (pinia) disposePinia(pinia)
  pinia = undefined
  configureClient(host)
  i18n.global.locale.value = "en-US"
  await router.replace("/")
})

async function render() {
  wrapper = mount(AppUpdateNotice, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

test("offers the available version and starts an update only after the click", async () => {
  const view = await render()
  expect(view.text()).toContain("Version 0.2.0 is available")
  expect(install).not.toHaveBeenCalled()
  await view.get("button").trigger("click")
  expect(install).toHaveBeenCalledTimes(1)
})

test.each<UpdateState>([
  { status: "disabled" }, { status: "idle" }, { status: "checking" },
  { status: "error", error: "Offline" },
])("keeps $status without a new version out of the sidebar", async state => {
  get.mockResolvedValue(state)
  const view = await render()
  expect(view.find("button").exists()).toBe(false)
  expect(install).not.toHaveBeenCalled()
})

test("does not render an updater on the Web host", async () => {
  configureClient({ ...host, platform: "web", updates: undefined })
  const view = await render()
  expect(view.find("button").exists()).toBe(false)
  expect(get).not.toHaveBeenCalled()
})

test("shows download progress and restart state and prevents repeated clicks", async () => {
  let finish!: () => void
  install.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = await render()
  await view.get("button").trigger("click")
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(true)
  publish({ status: "downloading", version: "0.2.0", percent: 42.8 })
  await flushPromises()
  expect(view.get("button").text()).toBe("Downloading 42%")
  await view.get("button").trigger("click")
  expect(install).toHaveBeenCalledTimes(1)
  publish({ status: "installing", version: "0.2.0" })
  finish()
  await flushPromises()
  expect(view.get("button").text()).toBe("Restarting…")
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(true)
})

test("offers a retry after a failed update and translates the notice live", async () => {
  install.mockRejectedValueOnce(new Error("Download interrupted"))
  const view = await render()
  await view.get("button").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').attributes("title")).toBe("Download interrupted")
  expect(view.get('[role="alert"]').text()).toBe("Update failed. Retry, or quit and reopen DeskFleet.")
  expect(view.get("button").text()).toBe("Retry update")
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(false)
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await flushPromises()
  expect(view.text()).toContain("新版本 0.2.0 已可用")
  expect(view.get("button").text()).toBe("重试更新")
  expect(view.get('[role="alert"]').text()).toBe("更新失败，请重试，或退出并重新打开 DeskFleet。")
  await view.get("button").trigger("click")
  expect(install).toHaveBeenCalledTimes(2)
})

test("new events win over an older initial snapshot and unsubscribe on unmount", async () => {
  let resolveGet!: (value: UpdateState) => void
  get.mockImplementation(() => new Promise(resolve => { resolveGet = resolve }))
  const view = await render()
  publish({ status: "available", version: "0.3.0" })
  resolveGet({ status: "idle" })
  await flushPromises()
  expect(view.text()).toContain("Version 0.3.0 is available")
  view.unmount()
  wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

test("keeps the updater above the account footer when no machine is selected", async () => {
  pinia = createPinia()
  const central = fakeCentral()
  const desktopHost = { ...host, updates: api, central: central.central }
  configureClient(desktopHost)
  await router.replace("/")
  wrapper = mount(AccountShell, { props: { host: desktopHost }, global: { plugins: [pinia, router, i18n] } })
  await vi.waitFor(() => expect(wrapper!.find("aside [data-app-update]").exists()).toBe(true))
  const notice = wrapper.get("aside [data-app-update]").element
  expect(notice.nextElementSibling?.tagName).toBe("FOOTER")
  expect(install).not.toHaveBeenCalled()
})
