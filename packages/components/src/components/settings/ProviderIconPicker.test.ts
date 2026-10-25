import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import ProviderIconPicker from "./ProviderIconPicker.vue"

let wrapper: VueWrapper | undefined
async function render(icon?: string, disabled = false) {
  wrapper = mount(ProviderIconPicker, { props: { modelValue: icon, template: "codex", disabled }, global: { plugins: [i18n] } })
  if (icon) await vi.waitFor(() => expect(wrapper!.find("[data-provider-icon]").exists()).toBe(true))
  return wrapper
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined; i18n.global.locale.value = "en-US" })

async function openChooser(view: VueWrapper): Promise<void> {
  await view.get('button[aria-expanded]').trigger("click")
  await vi.waitFor(() => expect(view.find('input[type="search"]').exists()).toBe(true))
}

test("a second click while the catalog is opening does not immediately close the chooser", async () => {
  const view = await render()
  const button = view.get('button[aria-expanded]').element
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(view.find('input[type="search"]').exists()).toBe(true))
  expect(view.get('button[aria-expanded]').attributes("aria-expanded")).toBe("true")
})

test("searches the LLM icon catalog and selects an icon without submitting the form", async () => {
  const view = await render()
  expect(view.text()).toContain("Template default")
  expect(view.find('[name="provider-icon-search"]').exists()).toBe(false)
  await openChooser(view)
  await view.get('input[type="search"]').setValue("deepseek")
  expect(view.findAll("[data-provider-icon-choice]").length).toBeGreaterThan(0)
  expect(view.get('[data-provider-icon-choice="deepseek"]').text()).toBe("DeepSeek")
  expect(view.get('[data-provider-icon-choice="deepseek"]').attributes("type")).toBe("button")
  await view.get('[data-provider-icon-choice="deepseek"]').trigger("click")
  expect(view.emitted("update:modelValue")).toEqual([["deepseek"]])
  expect(view.get('button[aria-expanded]').attributes("aria-expanded")).toBe("false")
})

test("shows the selected icon and resets to the template default", async () => {
  const view = await render("openai")
  expect(view.text()).toContain("OpenAI")
  await openChooser(view)
  expect(view.get('[data-provider-icon-choice="openai"]').attributes("aria-pressed")).toBe("true")
  expect(view.get("[data-default-icon]").attributes("aria-pressed")).toBe("false")
  await view.get("[data-default-icon]").trigger("click")
  expect(view.emitted("update:modelValue")).toEqual([[undefined]])
})

test("handles empty searches and lets Escape collapse the chooser before dismissing a dialog", async () => {
  const view = await render()
  await openChooser(view)
  await view.get('input[type="search"]').setValue("no-such-model-brand")
  expect(view.get('[role="status"]').text()).toBe("No matching icons.")
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  view.get('input[type="search"]').element.dispatchEvent(escape)
  await flushPromises()
  expect(escape.defaultPrevented).toBe(true)
  expect(view.find('input[type="search"]').exists()).toBe(false)
  const closedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  view.get('button[aria-expanded]').element.dispatchEvent(closedEscape)
  expect(closedEscape.defaultPrevented).toBe(false)
})

test("does not change the icon while saving and localizes the chooser", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const view = await render(undefined, true)
  expect(view.text()).toContain("模板默认图标")
  expect(view.get('button[aria-expanded]').attributes("disabled")).toBeDefined()
  await view.get('button[aria-expanded]').trigger("click")
  expect(view.find('input[type="search"]').exists()).toBe(false)
  expect(view.emitted("update:modelValue")).toBeUndefined()
})
