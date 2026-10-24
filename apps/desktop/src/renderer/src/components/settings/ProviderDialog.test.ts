import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderConfig } from "../../../../../../daemon/src/provider-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import ProviderDialog from "./ProviderDialog.vue"

let wrapper: VueWrapper | undefined
function render(save = vi.fn().mockResolvedValue(undefined), initial?: AgentProviderConfig, test = vi.fn().mockResolvedValue({ agentName: "Claude Agent" })) {
  wrapper = mount(ProviderDialog, { props: { save, test, initial, templates: [...AGENT_PROVIDER_TEMPLATES] }, global: { plugins: [i18n] } })
  return { view: wrapper, save, test }
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

test("the Claude Code template defaults to the installed claude CLI and its mark", async () => {
  const { view, save } = render()
  await view.get("select").setValue("claude-code")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("Claude Code")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("claude")
  expect(view.text()).toContain("Runs the installed Claude Code CLI through the built-in ACP bridge.")
  expect(view.get("[data-provider-icon]").attributes("data-provider-icon")).toBe("claudecode")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "claude-code", name: "Claude Code", binaryPath: undefined, icon: undefined, env: {} })
})

test("the Cursor template defaults to the installed agent CLI and its mark", async () => {
  const { view, save } = render()
  await view.get("select").setValue("cursor")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("Cursor")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("agent")
  expect(view.text()).toContain("The default command is agent acp.")
  expect(view.get("[data-provider-icon]").attributes("data-provider-icon")).toBe("cursor")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "cursor", name: "Cursor", binaryPath: undefined, icon: undefined, env: {} })
})

test("the Grok template defaults to the installed grok CLI and its mark", async () => {
  const { view, save } = render()
  await view.get("select").setValue("grok")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("Grok")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("grok")
  expect(view.text()).toContain("The default command is grok agent stdio.")
  expect(view.get("[data-provider-icon]").attributes("data-provider-icon")).toBe("grok")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "grok", name: "Grok", binaryPath: undefined, icon: undefined, env: {} })
})

test("tests the unsaved settings without saving and clears a result once launch settings change", async () => {
  let finish: (result: { agentName: string }) => void = () => {}
  const { view, save, test } = render(undefined, undefined, vi.fn(() => new Promise(resolve => { finish = resolve })))
  await view.get("select").setValue("claude-code")
  await view.get('[name="provider-binary"]').setValue(" /opt/claude ")
  await button(view, "Test").trigger("click")
  expect(button(view, "Testing…").attributes("disabled")).toBeDefined()
  expect(view.get("[data-provider-test-result]").attributes("role")).toBe("status")
  finish({ agentName: "Claude Agent" })
  await flushPromises()
  expect(test).toHaveBeenCalledExactlyOnceWith({ template: "claude-code", name: "Claude Code", binaryPath: "/opt/claude", icon: undefined, env: {} })
  expect(save).not.toHaveBeenCalled()
  expect(view.get("[data-provider-test-result]").text()).toBe("Connected. Claude Agent started a session.")
  await view.get('[name="provider-name"]').setValue("Renamed")
  expect(view.find("[data-provider-test-result]").exists()).toBe(true)
  await view.get('[name="provider-binary"]').setValue("/opt/other")
  expect(view.find("[data-provider-test-result]").exists()).toBe(false)
  expect(view.emitted("saved")).toBeUndefined()
})

test("shows the daemon's failure and ignores a result from settings edited during the test", async () => {
  let finish: (error: Error) => void = () => {}
  const test = vi.fn()
    .mockRejectedValueOnce(new Error("Claude Code native binary not found at /missing"))
    .mockImplementationOnce(() => new Promise((_, reject) => { finish = reject }))
  const { view } = render(undefined, undefined, test)
  await button(view, "Test").trigger("click")
  await flushPromises()
  const failure = view.get("[data-provider-test-result]")
  expect(failure.attributes("role")).toBe("alert")
  expect(failure.text()).toBe("Test failed: Claude Code native binary not found at /missing")
  await button(view, "Test").trigger("click")
  await view.get('[name="provider-binary"]').setValue("/opt/codex")
  finish(new Error("stale failure"))
  await flushPromises()
  expect(view.find("[data-provider-test-result]").exists()).toBe(false)
  expect(button(view, "Test").attributes("disabled")).toBeUndefined()
})

test("an edit made in the same tick as Test is part of the tested settings", async () => {
  const { view, test } = render()
  const binary = view.get('[name="provider-binary"]').element as HTMLInputElement
  binary.value = "/opt/codex"
  binary.dispatchEvent(new Event("input"))
  ;(button(view, "Test").element as HTMLButtonElement).click()
  await flushPromises()
  expect(test).toHaveBeenCalledWith(expect.objectContaining({ binaryPath: "/opt/codex" }))
  expect(view.get("[data-provider-test-result]").text()).toBe("Connected. Claude Agent started a session.")
})

test("validates the form before testing", async () => {
  const { view, test } = render()
  await view.get('[name="provider-name"]').setValue(" ")
  await button(view, "Test").trigger("click")
  expect(view.get('[role="alert"]').text()).toBe("Enter a provider name.")
  expect(test).not.toHaveBeenCalled()
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
