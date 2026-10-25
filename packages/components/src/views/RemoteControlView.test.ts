import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent } from "vue"
import { createMemoryHistory, createRouter, type LocationQueryRaw } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import type { FilesApi } from "../../../client/src/files.ts"
import type { TerminalSummary } from "../../../client/src/terminal.ts"
import { i18n } from "../i18n/index.ts"
import { useRouteResource } from "../composables/useRouteResource.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import RemoteControlView from "./RemoteControlView.vue"

const TerminalStub = defineComponent({
  name: "TerminalWorkspace", props: ["activeId", "terminals", "create"], emits: ["update:activeId"],
  template: '<div data-tool="terminal" />',
})
const DesktopStub = defineComponent({ name: "DesktopView", props: ["machineId"], template: '<div data-tool="desktop" />' })
const FilesStub = defineComponent({ name: "FileTransferPanel", props: ["api", "target", "machineName"], template: '<div data-tool="files" />' })
const shell: TerminalSummary = { id: "shell", title: "zsh", cwd: "/workspace", cols: 80, rows: 24, status: "running" }
const originalFiles = platformClient.files
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  platformClient.files = originalFiles
  vi.restoreAllMocks()
})

async function setup(options: { desktop?: boolean; machineId?: string; query?: LocationQueryRaw; sessions?: TerminalSummary[]; realDesktop?: boolean } = {}) {
  const files: FilesApi = {
    list: vi.fn(async () => { throw new Error("Unexpected file listing") }),
    chooseLocalDirectory: vi.fn(async () => null), enqueue: vi.fn(async () => "transfer"), transfers: vi.fn(async () => []),
    cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), onChanged: vi.fn(() => () => {}),
    resolveResource: vi.fn(async () => { throw new Error("Unexpected resource resolution") }),
    readResource: vi.fn(async () => { throw new Error("Unexpected resource read") }), saveResource: vi.fn(async () => null),
  }
  platformClient.files = files
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  const terminals = useTerminalsStore()
  fleet.machines[0]!.desktop = options.desktop ?? false
  fleet.machines[0]!.online = true
  fleet.machines.push({ id: "other", name: "Other machine", local: false, online: true, desktop: false, terminals: [], workspaces: [] })
  terminals.sessions = options.sessions ?? [shell]
  const create = vi.spyOn(terminals, "create")
  const router = createRouter({ history: createMemoryHistory(), routes: [{
    path: "/machines/:machineId/control", name: "machine-control", component: RemoteControlView, props: true,
  }] })
  await router.push({ name: "machine-control", params: { machineId: options.machineId ?? fleet.targetId }, query: options.query })
  const host = defineComponent({ setup: useRouteResource, template: "<RouterView />" })
  const wrapper = mount(host, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: {
      TerminalWorkspace: TerminalStub, DesktopView: options.realDesktop ? false : DesktopStub, FileTransferPanel: FilesStub,
    } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()
  return { wrapper, router, fleet, terminals, files, create }
}

const tabs = (wrapper: VueWrapper) => wrapper.findAll('[role="tab"]')
async function select(wrapper: VueWrapper, index: number) {
  await tabs(wrapper)[index]!.trigger("click")
  await flushPromises()
}

test("a headless machine defaults to Terminal without mounting Desktop or Files", async () => {
  const { wrapper, create } = await setup()
  expect(tabs(wrapper).map(tab => tab.attributes("aria-selected"))).toEqual(["true", "false", "false"])
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(true)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(create).not.toHaveBeenCalled()
})

test("tools mount only when first visited and keep the same instances across tab switches", async () => {
  const { wrapper, files } = await setup({ desktop: true })
  const desktop = wrapper.getComponent(DesktopStub).vm
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  await select(wrapper, 0)
  const terminal = wrapper.getComponent(TerminalStub).vm
  expect(wrapper.getComponent(DesktopStub).isVisible()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  await select(wrapper, 2)
  const filePanel = wrapper.getComponent(FilesStub)
  const fileInstance = filePanel.vm
  expect(filePanel.props("api")).toBe(files)
  expect(filePanel.props("target")).toEqual({ kind: "local" })
  expect(wrapper.getComponent(TerminalStub).isVisible()).toBe(false)
  await select(wrapper, 1)
  expect(wrapper.getComponent(DesktopStub).vm).toBe(desktop)
  expect(wrapper.getComponent(DesktopStub).isVisible()).toBe(true)
  await select(wrapper, 0)
  expect(wrapper.getComponent(TerminalStub).vm).toBe(terminal)
  await select(wrapper, 2)
  expect(wrapper.getComponent(FilesStub).vm).toBe(fileInstance)
  expect(wrapper.getComponent(FilesStub).isVisible()).toBe(true)
})

test("Terminal lists only machine-owned shells and rejects a Session shell in the query", async () => {
  const sessionShell = { ...shell, id: "session-shell", worktreeId: "worktree" }
  const { wrapper, router } = await setup({ desktop: true, sessions: [shell, sessionShell], query: { tab: "terminal", terminal: sessionShell.id } })
  const terminal = wrapper.getComponent(TerminalStub)
  expect(terminal.props("terminals")).toEqual([shell])
  expect(terminal.props("activeId")).toBeUndefined()
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  await router.replace({ query: { tab: "terminal", terminal: shell.id } })
  await flushPromises()
  expect(terminal.props("activeId")).toBe(shell.id)
})

test("a hidden Terminal follows shell removal without switching away from Files", async () => {
  const next = { ...shell, id: "next" }
  const { wrapper, router, terminals } = await setup({ sessions: [shell, next], query: { tab: "terminal", terminal: shell.id } })
  const terminal = wrapper.getComponent(TerminalStub)
  await select(wrapper, 2)
  const replace = vi.spyOn(router, "replace")
  terminals.sessions = [next]
  terminal.vm.$emit("update:activeId", next.id)
  await flushPromises()
  expect(replace).toHaveBeenCalledOnce()
  expect(router.currentRoute.value.query).toEqual({ tab: "files", terminal: next.id })
  expect(wrapper.getComponent(FilesStub).isVisible()).toBe(true)
  expect(terminal.isVisible()).toBe(false)
  terminals.sessions = []
  terminal.vm.$emit("update:activeId", undefined)
  await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ tab: "files" })
})

test("details follow the visible tool and never expose Worktree changes for machine control", async () => {
  const { wrapper } = await setup({ query: { tab: "terminal", terminal: shell.id } })
  expect(wrapper.vm.resource).toMatchObject({ kind: "terminal", terminal: { id: shell.id } })
  expect(wrapper.vm.worktree).toBeNull()
  await select(wrapper, 2)
  expect(wrapper.vm.resource).toMatchObject({ kind: "control", machine: { id: "local-daemon" } })
  expect(wrapper.vm.worktree).toBeNull()
  await select(wrapper, 1)
  expect(wrapper.vm.resource).toMatchObject({ kind: "control", machine: { id: "local-daemon" } })
  expect(wrapper.vm.worktree).toBeNull()
})

test.each([
  { desktop: false, selected: 0, kind: "terminal" },
  { desktop: true, selected: 1, kind: "control" },
])("an invalid tab uses the same default in the tool view and details (desktop=$desktop)", async ({ desktop, selected, kind }) => {
  const { wrapper } = await setup({ desktop, query: { tab: "invalid", terminal: shell.id } })
  expect(tabs(wrapper)[selected]!.attributes("aria-selected")).toBe("true")
  expect(wrapper.vm.resource?.kind).toBe(kind)
  expect(wrapper.vm.worktree).toBeNull()
})

test("keyboard navigation selects and focuses tabs, wrapping at either end", async () => {
  const { wrapper, router } = await setup()
  const move = async (index: number, key: string, expected: number) => {
    await tabs(wrapper)[index]!.trigger("keydown", { key })
    await flushPromises()
    expect(tabs(wrapper)[expected]!.attributes("aria-selected")).toBe("true")
    expect(tabs(wrapper)[expected]!.attributes("tabindex")).toBe("0")
    expect(document.activeElement).toBe(tabs(wrapper)[expected]!.element)
    expect(router.currentRoute.value.query.tab).toBe(["terminal", "desktop", "files"][expected])
  }
  await move(0, "ArrowLeft", 2)
  await move(2, "ArrowRight", 0)
  await move(0, "End", 2)
  await move(2, "Home", 0)
  await move(0, "ArrowRight", 1)
})

test("an unknown machine mounts no tools", async () => {
  const { wrapper, create, files } = await setup({ machineId: "missing", query: { tab: "files" } })
  expect(tabs(wrapper)).toHaveLength(0)
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(create).not.toHaveBeenCalled()
  expect(files.list).not.toHaveBeenCalled()
})

test("a machine outside the current adapter cannot start local terminal, desktop, or file tools", async () => {
  const target = vi.spyOn(platformClient.desktop, "target")
  const capabilities = vi.spyOn(platformClient.desktop, "capabilities")
  const offer = vi.spyOn(platformClient.desktop, "offer")
  const { wrapper, create, files } = await setup({ machineId: "other", realDesktop: true })
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  await select(wrapper, 2)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  await select(wrapper, 1)
  expect(wrapper.find("[data-desktop-stage]").exists()).toBe(true)
  expect(target).not.toHaveBeenCalled()
  expect(capabilities).not.toHaveBeenCalled()
  expect(offer).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(files.list).not.toHaveBeenCalled()
})

test("changing the machine clears previously visited panels and their instances", async () => {
  const { wrapper, router, fleet } = await setup()
  const terminal = wrapper.getComponent(TerminalStub).vm
  await select(wrapper, 1)
  await select(wrapper, 2)
  await router.push({ name: "machine-control", params: { machineId: "other" } })
  await flushPromises()
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  await router.push({ name: "machine-control", params: { machineId: fleet.targetId } })
  await flushPromises()
  expect(wrapper.getComponent(TerminalStub).vm).not.toBe(terminal)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
})
