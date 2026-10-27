import { configureClient, getClient } from "@deskfleet/client/platform"
import { DEFAULT_APPEARANCE_SETTINGS, DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, type AppearanceSettings } from "@deskfleet/client/appearance"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import AccountShell from "../../AccountShell.vue"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import { fakeCentral } from "../../test/central.ts"
import { selectOption } from "../../test/controls.ts"
import AppearanceSettingsView from "./AppearanceSettings.vue"

const host = getClient()
let pinia: ReturnType<typeof createPinia>
let view: VueWrapper | undefined
const get = vi.fn(async (): Promise<AppearanceSettings> => ({ ...DEFAULT_APPEARANCE_SETTINGS }))
const set = vi.fn(async (value: AppearanceSettings): Promise<AppearanceSettings> => ({ ...value }))

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  get.mockReset().mockResolvedValue({ ...DEFAULT_APPEARANCE_SETTINGS })
  set.mockReset().mockImplementation(async value => ({ ...value }))
  configureClient({ ...host, appearance: { get, set, onChanged: () => () => {} } })
  i18n.global.locale.value = "en-US"
})

afterEach(async () => {
  view?.unmount()
  view = undefined
  disposePinia(pinia)
  configureClient(host)
  document.documentElement.removeAttribute("style")
  i18n.global.locale.value = "en-US"
  await router.replace("/")
})

async function render() {
  view = mount(AppearanceSettingsView, { attachTo: document.body, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  return view
}

test("changes theme and language through the visible selectors", async () => {
  const wrapper = await render()
  await selectOption(wrapper, '[data-control-name="appearance-theme"]', "Dark")
  expect(set).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark" })
  expect(document.documentElement.style.colorScheme).toBe("dark")
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "简体中文")
  expect(wrapper.get("h1").text()).toBe("外观")
  expect(wrapper.get('[data-control-name="appearance-theme"]').text()).toBe("深色")
  await selectOption(wrapper, '[data-control-name="appearance-theme"]', "跟随系统")
  expect(document.documentElement.style.colorScheme).toBe("light dark")
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "English")
  expect(wrapper.get("h1").text()).toBe("Appearance")
})

test("previews font drafts and saves full CSS fallback lists on commit", async () => {
  const wrapper = await render()
  const font = '"Cascadia Code", "Noto Sans Mono CJK SC", monospace'
  const input = wrapper.get<HTMLInputElement>('#appearance-terminal-font')
  input.element.value = font
  await input.trigger("input")
  expect(set).not.toHaveBeenCalled()
  expect(wrapper.get<HTMLElement>('[data-terminal-font-preview]').element.style.fontFamily).toBe(font)
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(set).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_SETTINGS, terminalFont: font })
  expect(useAppearanceStore(pinia).terminalFont).toBe(font)
  await wrapper.get<HTMLInputElement>('#appearance-interface-font').setValue('"Inter", sans-serif')
  await flushPromises()
  expect(useAppearanceStore(pinia).interfaceFont).toBe('"Inter", sans-serif')
  await input.setValue("")
  await wrapper.get<HTMLInputElement>('#appearance-interface-font').setValue("")
  await flushPromises()
  expect(useAppearanceStore(pinia).terminalFont).toBe(DEFAULT_TERMINAL_FONT)
  expect(useAppearanceStore(pinia).interfaceFont).toBe(DEFAULT_INTERFACE_FONT)
})

test("keeps a failed font edit available to retry", async () => {
  set.mockRejectedValueOnce(new Error("Could not save appearance"))
  const wrapper = await render()
  const input = wrapper.get<HTMLInputElement>('#appearance-terminal-font')
  await input.setValue('"JetBrains Mono", monospace')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Could not save appearance")
  expect(input.element.value).toBe('"JetBrains Mono", monospace')
  expect(useAppearanceStore(pinia).settings.terminalFont).toBe("")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(useAppearanceStore(pinia).settings.terminalFont).toBe('"JetBrains Mono", monospace')
})

test.each(["win32", "web"] as const)("appearance is available without a machine on %s", async platform => {
  const { central } = fakeCentral()
  const api = { ...getClient(), platform, central }
  configureClient(api)
  view = mount(AccountShell, { props: { host: api }, attachTo: document.body, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  await view.get('button[aria-label="Settings"]').trigger("click")
  await flushPromises()
  await view.findAll('nav button').find(button => button.text() === "Appearance")!.trigger("click")
  await flushPromises()
  expect(view.get("h1").text()).toBe("Appearance")
  expect(view.get<HTMLInputElement>('#appearance-terminal-font').element.disabled).toBe(false)
  expect(router.resolve({ name: "settings-appearance" }).path).toBe("/settings/appearance")
})
