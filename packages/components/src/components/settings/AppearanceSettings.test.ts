import { configureClient, getClient } from "@deskfleet/client/platform"
import { DEFAULT_APPEARANCE_SETTINGS, DEFAULT_INTERFACE_FONT, DEFAULT_TERMINAL_FONT, type AppearanceSettings } from "@deskfleet/client/appearance"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent } from "vue"
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
const TerminalSurfaceStub = defineComponent({
  name: "TerminalSurface",
  props: { fontFamily: String, ligatures: Boolean, banner: String, scrollback: Number },
  template: '<div data-terminal-surface-stub />',
})
const stubs = { TerminalSurface: TerminalSurfaceStub }

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
  document.documentElement.lang = "en-US"
  i18n.global.locale.value = "en-US"
  await router.replace("/")
})

async function render() {
  view = mount(AppearanceSettingsView, { attachTo: document.body, global: { plugins: [pinia, i18n], stubs } })
  await flushPromises()
  return view
}

test("changes theme through preview radios and translates their labels live", async () => {
  const wrapper = await render()
  const theme = (value: string) => wrapper.get(`[data-appearance-theme="${value}"]`)
  expect(theme("system").attributes("role")).toBe("radio")
  expect(theme("system").attributes("aria-checked")).toBe("true")
  expect(theme("light").attributes("aria-checked")).toBe("false")
  await theme("dark").trigger("click")
  await flushPromises()
  expect(set).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark" })
  expect(theme("dark").attributes("aria-checked")).toBe("true")
  expect(theme("system").attributes("aria-checked")).toBe("false")
  expect(document.documentElement.style.colorScheme).toBe("dark")
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "简体中文")
  expect(wrapper.get("h1").text()).toBe("外观")
  expect(theme("dark").text()).toBe("深色")
  expect(theme("dark").attributes("aria-label")).toBe("深色")
  expect(theme("system").attributes("aria-label")).toBe("跟随系统")
  await theme("system").trigger("click")
  await flushPromises()
  expect(theme("system").attributes("aria-checked")).toBe("true")
  expect(document.documentElement.style.colorScheme).toBe("light dark")
  await theme("light").trigger("click")
  await flushPromises()
  expect(theme("light").attributes("aria-checked")).toBe("true")
  expect(theme("system").attributes("aria-checked")).toBe("false")
  expect(document.documentElement.style.colorScheme).toBe("light")
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "English")
  expect(wrapper.get("h1").text()).toBe("Appearance")
  expect(theme("light").text()).toBe("Light")
})

test("selects Japanese, saves its locale, and translates the settings immediately", async () => {
  const wrapper = await render()
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "日本語")
  expect(set).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_SETTINGS, language: "ja-JP" })
  expect(wrapper.get("h1").text()).toBe("外観")
  expect(wrapper.get('[data-control-name="appearance-language"]').text()).toContain("日本語")
  expect(document.documentElement.lang).toBe("ja-JP")
  await selectOption(wrapper, '[data-control-name="appearance-language"]', "English")
  expect(wrapper.get("h1").text()).toBe("Appearance")
  expect(document.documentElement.lang).toBe("en-US")
})

test("previews font drafts and saves full CSS fallback lists on commit", async () => {
  const wrapper = await render()
  const font = '"Cascadia Code", "Noto Sans Mono CJK SC", monospace'
  const input = wrapper.get<HTMLInputElement>('#appearance-terminal-font')
  input.element.value = font
  await input.trigger("input")
  expect(set).not.toHaveBeenCalled()
  expect(wrapper.getComponent(TerminalSurfaceStub).props("fontFamily")).toBe(font)
  expect(useAppearanceStore(pinia).settings.terminalFont).toBe("")
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
  expect(wrapper.getComponent(TerminalSurfaceStub).props("fontFamily")).toBe(DEFAULT_TERMINAL_FONT)
})

test("ligature switch updates the saved setting and terminal preview", async () => {
  const wrapper = await render()
  const toggle = wrapper.get('[role="switch"][aria-labelledby="appearance-terminal-ligatures-label"]')
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(wrapper.getComponent(TerminalSurfaceStub).props("ligatures")).toBe(false)
  await toggle.trigger("click")
  await flushPromises()
  expect(set).toHaveBeenLastCalledWith({ ...DEFAULT_APPEARANCE_SETTINGS, terminalLigatures: true })
  expect(useAppearanceStore(pinia).settings.terminalLigatures).toBe(true)
  expect(toggle.attributes("aria-checked")).toBe("true")
  expect(wrapper.getComponent(TerminalSurfaceStub).props("ligatures")).toBe(true)
  await toggle.trigger("click")
  await flushPromises()
  expect(set).toHaveBeenLastCalledWith(DEFAULT_APPEARANCE_SETTINGS)
  expect(useAppearanceStore(pinia).settings.terminalLigatures).toBe(false)
  expect(wrapper.getComponent(TerminalSurfaceStub).props("ligatures")).toBe(false)
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
  view = mount(AccountShell, { props: { host: api }, attachTo: document.body, global: { plugins: [pinia, i18n, router], stubs } })
  await flushPromises()
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(view!.find('nav a[href="#/settings/appearance"]').exists()).toBe(true))
  await view.get('nav a[href="#/settings/appearance"]').trigger("click")
  await vi.waitFor(() => expect(view!.get("h1").text()).toBe("Appearance"))
  expect(view.get<HTMLInputElement>('#appearance-terminal-font').element.disabled).toBe(false)
  expect(router.currentRoute.value.path).toBe("/settings/appearance")
})
