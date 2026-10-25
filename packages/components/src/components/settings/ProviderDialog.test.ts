import { createPinia } from "pinia"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderConfig, type AgentProviderTemplateId } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { i18n } from "../../i18n/index.ts"
import ProviderDialog from "./ProviderDialog.vue"

let wrapper: VueWrapper | undefined
function render(save = vi.fn().mockResolvedValue(undefined), initial?: AgentProviderConfig, test = vi.fn().mockResolvedValue({ agentName: "Claude Agent" })) {
  const pinia = createPinia()
  wrapper = mount(ProviderDialog, { props: { save, test, initial, templates: [...AGENT_PROVIDER_TEMPLATES], machineName: "my-machine", probe: vi.fn().mockResolvedValue({ status: "missing", auth: "unknown", installable: true, loginAvailable: false }), install: vi.fn(), login: vi.fn() }, global: { plugins: [pinia, i18n], stubs: { LiveTerminal: true } } })
  return { view: wrapper, save, test, terminals: useTerminalsStore(pinia) }
}
const button = (view: VueWrapper, text: string) => view.findAll("button").find(value => value.text() === text)!
const pick = (view: VueWrapper, template: AgentProviderTemplateId) => view.get(`[data-provider-template-choice="${template}"]`).trigger("click")
const advancedOpen = (view: VueWrapper) => (view.get("[data-provider-advanced]").element as HTMLDetailsElement).open
afterEach(() => { wrapper?.unmount(); wrapper = undefined; i18n.global.locale.value = "en-US" })

test("chooses a template, leaves the binary default implicit, and preserves environment values", async () => {
  const { view, save } = render()
  expect(view.findAll("[data-provider-template-choice]").map(choice => choice.attributes("data-provider-template-choice"))).toEqual(AGENT_PROVIDER_TEMPLATES.map(template => template.id))
  expect(view.find("form").exists()).toBe(false)
  await pick(view, "codex")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("codex")
  expect(advancedOpen(view)).toBe(false)
  await view.get("[data-provider-back]").trigger("click")
  await pick(view, "acp")
  expect(view.get("[data-provider-template]").text()).toBe("ACP on my-machine")
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("ACP")
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("acp-agent")
  await view.get('[name="provider-name"]').setValue("  My agent  ")
  await view.get('button[aria-expanded]').trigger("click")
  await vi.waitFor(() => expect(view.find('input[type="search"]').exists()).toBe(true))
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

test.each([
  ["claude-code", "Claude Code", "claude", "claudecode"],
  ["cursor", "Cursor", "agent", "cursor"],
  ["grok", "Grok", "grok", "grok"],
  ["pi", "Pi Coding Agent", "pi", "pi"],
] as const)("the %s template defaults to its installed CLI and mark", async (template, name, binary, mark) => {
  const { view, save } = render()
  await pick(view, template)
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe(name)
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe(binary)
  await vi.waitFor(() => expect(view.get("[data-provider-icon]").attributes("data-provider-icon")).toBe(mark))
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(save).toHaveBeenCalledExactlyOnceWith({ template, name, binaryPath: undefined, icon: undefined, env: {} })
})

test("tests the unsaved settings without saving and clears a result once launch settings change", async () => {
  let finish: (result: { agentName: string }) => void = () => {}
  const { view, save, test } = render(undefined, undefined, vi.fn(() => new Promise(resolve => { finish = resolve })))
  await pick(view, "claude-code")
  await view.get('[name="provider-binary"]').setValue(" /opt/claude ")
  await button(view, "Test connection").trigger("click")
  expect(button(view, "Testing connection…").attributes("disabled")).toBeDefined()
  expect(view.get("[data-provider-test-result]").attributes("role")).toBe("status")
  finish({ agentName: "Claude Agent" })
  await flushPromises()
  expect(test).toHaveBeenCalledExactlyOnceWith({ template: "claude-code", name: "Claude Code", binaryPath: "/opt/claude", icon: undefined, env: {} })
  expect(save).not.toHaveBeenCalled()
  expect(view.get("[data-provider-test-result]").text()).toBe("Connected to Claude Agent.")
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
  await pick(view, "codex")
  await button(view, "Test connection").trigger("click")
  await flushPromises()
  const failure = view.get("[data-provider-test-result]")
  expect(failure.attributes("role")).toBe("alert")
  expect(failure.text()).toBe("Connection failed: Claude Code native binary not found at /missing")
  expect(view.find("[data-provider-test-details-toggle]").exists()).toBe(false)
  await button(view, "Test connection").trigger("click")
  await view.get('[name="provider-binary"]').setValue("/opt/codex")
  finish(new Error("stale failure"))
  await flushPromises()
  expect(view.find("[data-provider-test-result]").exists()).toBe(false)
  expect(button(view, "Test connection").attributes("disabled")).toBeUndefined()
})

test("summarizes a multi-line failure and reveals the full output on request", async () => {
  const output = "ACP initialize failed: Authentication required\n    at initialize (acp.js:212:11)\nstderr: not logged in"
  const { view } = render(undefined, undefined, vi.fn().mockRejectedValue(new Error(output)))
  await pick(view, "codex")
  await button(view, "Test connection").trigger("click")
  await flushPromises()
  expect(view.get("[data-provider-test-summary]").text()).toBe("Connection failed: ACP initialize failed: Authentication required")
  expect(view.find("[data-provider-test-details]").exists()).toBe(false)
  await view.get("[data-provider-test-details-toggle]").trigger("click")
  expect(view.get("[data-provider-test-details]").text()).toBe(output)
  expect(view.get("[data-provider-test-details-toggle]").attributes("aria-expanded")).toBe("true")
})

test("an edit made in the same tick as Test is part of the tested settings", async () => {
  const { view, test } = render()
  await pick(view, "codex")
  const binary = view.get('[name="provider-binary"]').element as HTMLInputElement
  binary.value = "/opt/codex"
  binary.dispatchEvent(new Event("input"))
  ;(button(view, "Test connection").element as HTMLButtonElement).click()
  await flushPromises()
  expect(test).toHaveBeenCalledWith(expect.objectContaining({ binaryPath: "/opt/codex" }))
  expect(view.get("[data-provider-test-result]").text()).toBe("Connected to Claude Agent.")
})

test("validates the form before testing", async () => {
  const { view, test } = render()
  await pick(view, "codex")
  await view.get('[name="provider-name"]').setValue(" ")
  await button(view, "Test connection").trigger("click")
  expect(view.get('[role="alert"]').text()).toBe("Enter a provider name.")
  expect(test).not.toHaveBeenCalled()
})

test("keeps the template immutable when editing and supports removing variables", async () => {
  const { view, save } = render(undefined, { id: "codex", template: "codex", name: "Personal", icon: "claude", binaryPath: "/old/codex", env: { TOKEN: "secret" } })
  expect(view.find("[data-provider-template-choice]").exists()).toBe(false)
  expect(view.find("[data-provider-back]").exists()).toBe(false)
  expect(view.get("[data-provider-template]").text()).toBe("Codex on my-machine")
  // Existing overrides are visible without expanding Advanced.
  expect(advancedOpen(view)).toBe(true)
  await view.get('[name="provider-binary"]').setValue("  ")
  await view.get('[aria-label="Remove environment variable 1"]').trigger("click")
  await view.get("form").trigger("submit")
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "codex", name: "Personal", binaryPath: undefined, icon: "claude", env: {} })
})

test("rejects missing and duplicate environment names before saving and reveals them", async () => {
  const { view, save } = render()
  await pick(view, "codex")
  await button(view, "Add variable").trigger("click")
  expect(advancedOpen(view)).toBe(false)
  await view.get("form").trigger("submit")
  expect(view.get('[role="alert"]').text()).toContain("Each variable needs a name")
  expect(advancedOpen(view)).toBe(true)
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
  await pick(view, "codex")
  await view.get('[name="provider-name"]').setValue("Work")
  await view.get("form").trigger("submit")
  expect(view.get('button[type="submit"]').attributes("disabled")).toBeDefined()
  expect(button(view, "Cancel").attributes("disabled")).toBeDefined()
  expect(view.get("[data-provider-back]").attributes("aria-disabled")).toBe("true")
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
  expect(view.text()).toContain("Anthropic 的编程 Agent")
  await pick(view, "codex")
  expect(view.text()).toContain("环境变量")
  await view.get("dialog").trigger("cancel")
  expect(view.emitted("cancel")).toEqual([[]])
  expect(save).not.toHaveBeenCalled()
})

test("offers login separately, blocks Test during login, and saves the discovered executable", async () => {
  const { view, save, test: testConnection, terminals } = render()
  const login = vi.fn().mockResolvedValue({ id: "login-1", title: "Login", cwd: "/home/user", cols: 80, rows: 24, status: "running" })
  await view.setProps({ login, probe: vi.fn().mockResolvedValue({ status: "found", binaryPath: "/tools/cursor-agent", auth: "unauthenticated", installable: true, loginAvailable: true }) })
  await pick(view, "cursor")
  await flushPromises()
  expect(view.get('[name="provider-binary"]').attributes("placeholder")).toBe("/tools/cursor-agent")
  await view.get("[data-provider-login]").trigger("click")
  await flushPromises()
  expect(login).toHaveBeenCalledExactlyOnceWith({ template: "cursor", name: "Cursor", binaryPath: "/tools/cursor-agent", env: {} })
  expect(testConnection).not.toHaveBeenCalled()
  expect(button(view, "Test connection").attributes("disabled")).toBeDefined()
  expect(button(view, "Cancel").attributes("disabled")).toBeDefined()
  terminals.sessions.push({ id: "login-1", title: "Login", cwd: "/home/user", cols: 80, rows: 24, status: "exited", exitCode: 0 })
  await flushPromises()
  await view.get("form").trigger("submit")
  expect(save).toHaveBeenCalledExactlyOnceWith({ template: "cursor", name: "Cursor", binaryPath: "/tools/cursor-agent", icon: undefined, env: {} })
  expect(testConnection).not.toHaveBeenCalled()
})

test("a completed installation fills the binary field and retains the refreshed login state", async () => {
  const { view, terminals } = render()
  const probe = vi.fn().mockResolvedValueOnce({ status: "missing", auth: "unknown", installable: true, loginAvailable: false })
    .mockResolvedValue({ status: "found", binaryPath: "/installed/codex", auth: "unauthenticated", installable: true, loginAvailable: true })
  const install = vi.fn().mockResolvedValue({ id: "install-1", title: "Install", cwd: "/home/user", cols: 80, rows: 24, status: "running" })
  await view.setProps({ probe, install })
  await pick(view, "codex")
  await flushPromises()
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  terminals.sessions.push({ id: "install-1", title: "Install", cwd: "/home/user", cols: 80, rows: 24, status: "exited", exitCode: 0 })
  await flushPromises()
  expect((view.get('[name="provider-binary"]').element as HTMLInputElement).value).toBe("/installed/codex")
  expect(view.get("[data-provider-status]").text()).toContain("Not signed in")
  expect(view.get("[data-provider-login]").attributes("disabled")).toBeUndefined()
  expect(probe).toHaveBeenCalledTimes(2)
})

test("Set path opens Advanced when the CLI cannot be installed automatically", async () => {
  const { view } = render()
  await view.setProps({ probe: vi.fn().mockResolvedValue({ status: "missing", auth: "unknown", installable: false, loginAvailable: false, installMessage: "No installer for this platform." }) })
  await pick(view, "codex")
  await flushPromises()
  expect(advancedOpen(view)).toBe(false)
  await view.get("[data-provider-set-path]").trigger("click")
  await flushPromises()
  expect(advancedOpen(view)).toBe(true)
})
