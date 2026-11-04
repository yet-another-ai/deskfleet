import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { RemoteAgentSettings as Settings } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import RemoteAgentSettings from "./RemoteAgentSettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); vi.restoreAllMocks(); i18n.global.locale.value = "en-US" })
const render = () => view = mount(RemoteAgentSettings, { global: { plugins: [i18n] } })

test("loads both permissions and only shows a change after it is saved", async () => {
  let loaded!: (value: Settings) => void
  let saved!: (value: Settings) => void
  vi.spyOn(client.settings, "getRemoteAgentSettings").mockImplementation(() => new Promise(resolve => { loaded = resolve }))
  const save = vi.spyOn(client.settings, "setRemoteAgentSettings").mockImplementation(() => new Promise(resolve => { saved = resolve }))
  const wrapper = render()
  const [read, operate] = wrapper.findAll('[role="switch"]')
  expect(read!.attributes("disabled")).toBeDefined()
  loaded({ allowRead: false, allowOperate: true })
  await flushPromises()
  expect(operate!.attributes("aria-checked")).toBe("true")
  await read!.trigger("click")
  expect(save).toHaveBeenCalledExactlyOnceWith({ allowRead: true, allowOperate: true })
  expect(read!.attributes("aria-checked")).toBe("false")
  expect(operate!.attributes("disabled")).toBeDefined()
  saved({ allowRead: true, allowOperate: true })
  await flushPromises()
  expect(read!.attributes("aria-checked")).toBe("true")
})

test("failed saves retain the confirmed permissions and failed loads can be retried", async () => {
  vi.spyOn(client.settings, "getRemoteAgentSettings").mockRejectedValueOnce(new Error("Load failed")).mockResolvedValue({ allowRead: true, allowOperate: false })
  vi.spyOn(client.settings, "setRemoteAgentSettings").mockRejectedValue(new Error("Save failed"))
  const wrapper = render()
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Load failed")
  await wrapper.get("button.ui-button").trigger("click")
  await flushPromises()
  const read = wrapper.findAll('[role="switch"]')[0]!
  await read.trigger("click")
  await flushPromises()
  expect(read.attributes("aria-checked")).toBe("true")
  expect(read.attributes("disabled")).toBeUndefined()
  expect(wrapper.get('[role="alert"]').text()).toBe("Save failed")
})

test("Chinese preferences explain the separate permissions", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const wrapper = render()
  await flushPromises()
  expect(wrapper.text()).toContain("允许其它机器上的 Agent 读取本机")
  expect(wrapper.text()).toContain("允许其它机器上的 Agent 操作本机")
  expect(wrapper.text()).toContain("读取对话由独立开关控制")
})
