import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import ProviderIconPicker from "./ProviderIconPicker.vue"

const page = () => new DOMWrapper(document.body)
let wrapper: VueWrapper | undefined
async function render(icon?: string, disabled = false) {
  wrapper = mount(ProviderIconPicker, { attachTo: document.body, props: { modelValue: icon, template: "codex", disabled }, global: { plugins: [i18n] } })
  if (icon) await vi.waitFor(() => expect(wrapper!.find("[data-provider-icon]").exists()).toBe(true))
  return wrapper
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined; i18n.global.locale.value = "en-US" })

async function openChooser(): Promise<void> {
  await page().get('button[aria-expanded]').trigger("click")
  await vi.waitFor(() => expect(page().find('input[type="search"]').exists()).toBe(true))
}

test("a second click while the catalog is opening does not immediately close the chooser", async () => {
  await render()
  const button = page().get('button[aria-expanded]').element
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(page().find('input[type="search"]').exists()).toBe(true))
  expect(page().get('button[aria-expanded]').attributes("aria-expanded")).toBe("true")
})

test("searches the LLM icon catalog and selects an icon without submitting the form", async () => {
  const view = await render()
  expect(page().get("button[aria-expanded]").attributes("aria-label")).toBe("Icon: Template default")
  expect(page().find('[name="provider-icon-search"]').exists()).toBe(false)
  await openChooser()
  await page().get('input[type="search"]').setValue("deepseek")
  expect(page().findAll("[data-provider-icon-choice]").length).toBeGreaterThan(0)
  expect(page().get('[data-provider-icon-choice="deepseek"]').text()).toBe("DeepSeek")
  expect(page().get('[data-provider-icon-choice="deepseek"]').attributes("type")).toBe("button")
  await page().get('[data-provider-icon-choice="deepseek"]').trigger("click")
  expect(view.emitted("update:modelValue")).toEqual([["deepseek"]])
  expect(page().get('button[aria-expanded]').attributes("aria-expanded")).toBe("false")
})

test("shows the selected icon and resets to the template default", async () => {
  const view = await render("openai")
  expect(page().get("button[aria-expanded]").attributes("aria-label")).toBe("Icon: OpenAI")
  await openChooser()
  expect(page().get('[data-provider-icon-choice="openai"]').attributes("aria-pressed")).toBe("true")
  expect(page().get("[data-default-icon]").attributes("aria-pressed")).toBe("false")
  await page().get("[data-default-icon]").trigger("click")
  expect(view.emitted("update:modelValue")).toEqual([[undefined]])
})

test("handles empty searches and lets Escape collapse the chooser before dismissing a dialog", async () => {
  await render()
  await openChooser()
  await page().get('input[type="search"]').setValue("no-such-model-brand")
  expect(page().get('[role="status"]').text()).toBe("No matching icons.")
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  page().get('input[type="search"]').element.dispatchEvent(escape)
  await flushPromises()
  expect(page().find('input[type="search"]').exists()).toBe(false)
  const closedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  page().get('button[aria-expanded]').element.dispatchEvent(closedEscape)
  expect(closedEscape.defaultPrevented).toBe(false)
})

test("does not change the icon while saving and localizes the chooser", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const view = await render(undefined, true)
  expect(page().get("button[aria-expanded]").attributes("aria-label")).toBe("图标：模板默认图标")
  expect(page().get('button[aria-expanded]').attributes("disabled")).toBeDefined()
  await page().get('button[aria-expanded]').trigger("click")
  expect(page().find('input[type="search"]').exists()).toBe(false)
  expect(view.emitted("update:modelValue")).toBeUndefined()
})

test("a click outside the chooser closes it without changing the icon", async () => {
  const view = await render()
  await openChooser()
  // Outside listeners are installed after the opening pointer event has finished.
  await new Promise(resolve => setTimeout(resolve, 0))
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }))
  document.body.dispatchEvent(new PointerEvent("click", { bubbles: true }))
  await flushPromises()
  expect(page().find('input[type="search"]').exists()).toBe(false)
  expect(view.emitted("update:modelValue")).toBeUndefined()
})
