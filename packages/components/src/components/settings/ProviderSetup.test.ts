import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import type { AgentProviderInput, ProviderProbeResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import ProviderSetup from "./ProviderSetup.vue"

const provider: AgentProviderInput = { template: "codex", name: "Codex", env: {} }
const missing: ProviderProbeResult = { status: "missing", auth: "unknown", installable: true, loginAvailable: false }
const found: ProviderProbeResult = { status: "found", binaryPath: "/home/user/.local/bin/codex", version: "codex-cli 1.0", auth: "unauthenticated", installable: true, loginAvailable: true }
const terminal: TerminalSummary = { id: "setup-1", title: "Codex setup", cwd: "/home/user", cols: 80, rows: 24, status: "running" }
let wrapper: VueWrapper | undefined

function render(probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>().mockResolvedValue(missing), input = provider) {
  const pinia = createPinia()
  const terminals = useTerminalsStore(pinia)
  const install = vi.fn().mockResolvedValue(terminal)
  const login = vi.fn().mockResolvedValue(terminal)
  wrapper = mount(ProviderSetup, {
    props: { provider: input, machineName: "build-machine", probe, install, login },
    global: { plugins: [pinia, i18n], stubs: { LiveTerminal: true } },
  })
  return { view: wrapper, probe, install, login, terminals }
}

afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })

test("probes as soon as the form opens and when its selected template changes", async () => {
  const { view, probe } = render()
  expect(probe).toHaveBeenCalledExactlyOnceWith(provider)
  await flushPromises()
  expect(view.get("[data-provider-status]").text()).toBe("Not installedInstall the official CLI on build-machine.")
  expect(view.get("[data-provider-install]").text()).toBe("Install")
  expect(view.find("[data-provider-login]").exists()).toBe(false)
  await view.setProps({ provider: { ...provider, template: "claude-code", name: "Claude Code" } })
  expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ template: "claude-code" }))
})

test("debounces changed launch settings and discards a previous template's late result", async () => {
  vi.useFakeTimers()
  let finish!: (value: ProviderProbeResult) => void
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(missing)
  const { view } = render(probe)
  await view.setProps({ provider: { ...provider, template: "grok", name: "Grok" } })
  await flushPromises()
  finish(found)
  await flushPromises()
  expect(view.find("[data-provider-binary-found]").exists()).toBe(false)
  await view.setProps({ provider: { ...provider, template: "grok", name: "Grok", binaryPath: "/tools/grok" } })
  await view.setProps({ provider: { ...provider, template: "grok", name: "Grok", binaryPath: "/tools/grok", env: { PATH: "/tools" } } })
  expect(probe).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(300)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ binaryPath: "/tools/grok", env: { PATH: "/tools" } }))
})

test("installs in its own terminal, then discovers and emits the installed absolute path", async () => {
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>().mockResolvedValueOnce(missing).mockResolvedValue(found)
  const input = { ...provider, binaryPath: "/missing/codex" }
  const { view, install, login, terminals } = render(probe, input)
  await flushPromises()
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  expect(install).toHaveBeenCalledExactlyOnceWith(input)
  expect(login).not.toHaveBeenCalled()
  expect(view.find("[data-provider-terminal]").exists()).toBe(true)
  // The running operation's Stop is the only action until it finishes.
  expect(view.find("[data-provider-probe]").exists()).toBe(false)
  expect(view.find("[data-provider-install]").exists()).toBe(false)
  expect(view.emitted("busy")?.at(-1)).toEqual([true])
  terminals.sessions.push({ ...terminal, status: "exited", exitCode: 0 })
  await flushPromises()
  expect(probe).toHaveBeenLastCalledWith({ ...input, binaryPath: undefined })
  expect(view.emitted("binaryPath")).toEqual([[found.binaryPath]])
  expect(view.emitted("resolved")?.at(-1)).toEqual([found.binaryPath])
  expect(view.emitted("busy")?.at(-1)).toEqual([false])
  expect(view.get("[data-provider-status]").text()).toContain("Not signed in")
  expect(view.find("[data-provider-terminal]").exists()).toBe(false)
})

test("login runs independently and refreshes auth without assuming a successful exit means signed in", async () => {
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>().mockResolvedValueOnce(found).mockResolvedValue({ ...found, auth: "unknown" })
  const { view, install, login, terminals } = render(probe)
  await flushPromises()
  expect(view.find("[data-provider-install]").exists()).toBe(false)
  await view.get("[data-provider-login]").trigger("click")
  await flushPromises()
  expect(login).toHaveBeenCalledExactlyOnceWith({ ...provider, binaryPath: found.binaryPath })
  expect(install).not.toHaveBeenCalled()
  terminals.sessions.push({ ...terminal, status: "exited", exitCode: 0 })
  await flushPromises()
  expect(probe).toHaveBeenCalledTimes(2)
  // An unknown status is not reported as signed in or signed out.
  expect(view.get("[data-provider-status]").text()).toBe("Installedcodex-cli 1.0")
})

test("a failed installer retains its output and reports its exit without adopting a path", async () => {
  const { view, probe, terminals } = render()
  await flushPromises()
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  terminals.sessions.push({ ...terminal, status: "exited", exitCode: 7 })
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain("status 7")
  expect(view.find("[data-provider-terminal]").exists()).toBe(true)
  expect(view.emitted("binaryPath")).toBeUndefined()
  expect(probe).toHaveBeenCalledOnce()
  expect(view.emitted("busy")?.at(-1)).toEqual([false])
})

test("Stop explicitly hangs up the setup terminal and allows the form to continue", async () => {
  const { view, probe, terminals } = render()
  const hangup = vi.spyOn(terminals, "hangup").mockResolvedValue()
  await flushPromises()
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  await view.get("[data-provider-stop]").trigger("click")
  await flushPromises()
  expect(hangup).toHaveBeenCalledExactlyOnceWith(terminal.id)
  expect(view.find("[data-provider-terminal]").exists()).toBe(false)
  expect(probe).toHaveBeenCalledTimes(2)
  expect(view.find("[data-provider-install]").exists()).toBe(true)
  expect(view.emitted("busy")?.at(-1)).toEqual([false])
})

test("generic ACP and unsupported platforms do not offer install or login, and point to a custom path", async () => {
  const { view } = render(undefined, { ...provider, template: "acp" })
  await flushPromises()
  expect(view.find("[data-provider-install]").exists()).toBe(false)
  expect(view.find("[data-provider-login]").exists()).toBe(false)
  await view.get("[data-provider-set-path]").trigger("click")
  expect(view.emitted("editPath")).toEqual([[]])
  await view.setProps({ probe: async () => ({ ...missing, installable: false, installMessage: "This platform has no installer." }) })
  await view.setProps({ provider })
  await flushPromises()
  expect(view.get("[data-provider-status-detail]").text()).toBe("This platform has no installer.")
  expect(view.find("[data-provider-install]").exists()).toBe(false)
  expect(view.find("[data-provider-set-path]").exists()).toBe(true)
})

test("a detection failure is reported in the status and can be retried", async () => {
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>()
    .mockRejectedValueOnce(new Error("Provider detection timed out.")).mockResolvedValue(found)
  const { view } = render(probe)
  await flushPromises()
  expect(view.get("[data-provider-status]").attributes("data-provider-status")).toBe("error")
  expect(view.get("[data-provider-status]").text()).toBe("Couldn't check build-machineProvider detection timed out.")
  await view.get("[data-provider-probe]").trigger("click")
  await flushPromises()
  expect(view.get("[data-provider-status]").text()).toContain("Not signed in")
})


test("an installer that has already exited when its start response arrives still completes setup", async () => {
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>().mockResolvedValueOnce(missing).mockResolvedValue(found)
  const { view, install } = render(probe)
  install.mockResolvedValue({ ...terminal, status: "exited", exitCode: 0 })
  await flushPromises()
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  expect(view.emitted("binaryPath")).toEqual([[found.binaryPath]])
  expect(view.emitted("busy")?.at(-1)).toEqual([false])
  expect(view.get("[data-provider-login]").attributes("disabled")).toBeUndefined()
})


test("an invalid executable offers installation of a usable CLI without offering login", async () => {
  const input: AgentProviderInput = { template: "cursor", name: "Cursor", env: {} }
  const probe = vi.fn<(provider: AgentProviderInput) => Promise<ProviderProbeResult>>().mockResolvedValue({
    ...missing, status: "invalid", message: "The agent executable belongs to Grok.",
    installMessage: "Install the official Cursor CLI.",
  })
  const { view, install, login } = render(probe, input)
  await flushPromises()
  expect(view.get("[data-provider-status]").text()).toBe("Can't use this executableThe agent executable belongs to Grok.")
  expect(view.find("[data-provider-login]").exists()).toBe(false)
  await view.get("[data-provider-install]").trigger("click")
  await flushPromises()
  expect(install).toHaveBeenCalledExactlyOnceWith(input)
  expect(login).not.toHaveBeenCalled()
  expect(view.find("[data-provider-terminal]").exists()).toBe(true)
})
