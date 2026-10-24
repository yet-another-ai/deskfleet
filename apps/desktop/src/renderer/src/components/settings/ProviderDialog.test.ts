import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderConfig } from "../../../../../../daemon/src/provider-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import ProviderDialog from "./ProviderDialog.vue"

let wrapper: VueWrapper | undefined
function render(save = vi.fn().mockResolvedValue(undefined), initial?: AgentProviderConfig) {
  wrapper = mount(ProviderDialog, { props: { save, initial, templates: [...AGENT_PROVIDER_TEMPLATES] }, global: { plugins: [i18n] } })
  return { view: wrapper, save }
}
const button = (view: VueWrapper, text: string) => view.findAll("button").find(value => value.text() === text)!
afterEach(() => { wrapper?.unmount(); wrapper = undefined; i18n.global.locale.value = "en-US" })

test("chooses a template, leaves the binary default implicit, and preserves environment values", async () => {
  const { view, save } = render()
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("codex")
  await view.get("select").setValue("acp")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("ACP")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("acp-agent")
  await view.get('[name="provider-name"]').setValue("  My agent  ")
  await view.get('button[aria-expanded]').trigger("click")
  await view.get('input[type="search"]').setValue("deepseek")
  await view.get('[data-provider-icon-choice="deepseek"]').trigger("click")
  await button(view, "Add variable").trigger("click")
  await view.get('[aria-label="Environment variable 1 key"]').setValue("API_TOKEN")
  await view.get('[aria-label="Environment variable 1 value"]').setValue("  value=one  ")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "acp", name: "My agent", binaryPath: undefined, icon: "deepseek", env: { API_TOKEN: "  value=one  " } })
  expect(view.emitted("saved")).toEqual([[]])
  expect(view.emitted("cancel")).toBeUndefined()
})

test("keeps the template immutable when editing and supports removing variables", async () => {
  const { view, save } = render(undefined, { id: "codex", template: "codex", name: "Personal", icon: "claude", binaryPath: "/old/codex", env: { TOKEN: "secret" } })
  expect(view.find("select").exists()).toBe(false)
  expect(view.get("[data-provider-template]").attributes("readonly")).toBeDefined()
  expect(view.text()).toContain("The template is fixed after creation.")
  await view.get('[name="provider-binary"]').setValue("  ")
  await view.get('[aria-label="Remove environment variable 1"]').trigger("click")
  await view.get("form").trigger("submit")
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "codex", name: "Personal", binaryPath: undefined, icon: "claude", env: {} })
})

test("rejects missing and duplicate environment names before saving", async () => {
  const { view, save } = render()
  await button(view, "Add variable").trigger("click")
  await view.get("form").trigger("submit")
  expect(view.get('[role="alert"]').text()).toContain("Each variable needs a name")
  expect(save).not.toHaveBeenCalled()
  await view.get('[aria-label="Environment variable 1 key"]').setValue("API_KEY")
  await button(view, "Add variable").trigger("click")
  await view.get('[aria-label="Environment variable 2 key"]').setValue(" API_KEY ")
  await view.get("form").trigger("submit")
  expect(view.get('[role="alert"]').text()).toBe("Environment variable names must be unique.")
  expect(save).not.toHaveBeenCalled()
  await view.get('[aria-label="Environment variable 2 key"]').setValue("SECOND_KEY")
  await view.get("form").trigger("submit")
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "codex", name: "Codex", binaryPath: undefined, icon: undefined, env: { API_KEY: "", SECOND_KEY: "" } })
})

test("prevents duplicate saves and dismissal while saving, and retains an unsuccessful draft", async () => {
  let reject!: (error: Error) => void
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail })).mockResolvedValue(undefined)
  const { view } = render(save)
  await view.get('[name="provider-name"]').setValue("Work")
  await view.get("form").trigger("submit")
  expect(view.get('button[type="submit"]').attributes("disabled")).toBeDefined()
  expect(button(view, "Cancel").attributes("disabled")).toBeDefined()
  await view.get("form").trigger("submit")
  await view.get("dialog").trigger("cancel")
  expect(save).toHaveBeenCalledTimes(1)
  expect(view.emitted("cancel")).toBeUndefined()
  reject(new Error("Disk is full"))
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Disk is full")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("Work")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(view.emitted("saved")).toEqual([[]])
})

test("localizes the form and cancels without changing settings", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const { view, save } = render()
  expect(view.text()).toContain("通过内置 ACP bridge")
  expect(view.text()).toContain("环境变量")
  await view.get("dialog").trigger("cancel")
  expect(view.emitted("cancel")).toEqual([[]])
  expect(save).not.toHaveBeenCalled()
})
