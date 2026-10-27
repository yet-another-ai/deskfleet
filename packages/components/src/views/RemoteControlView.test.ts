import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent, reactive } from "vue"
import { createMemoryHistory, createRouter, type LocationQueryRaw } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import type { FilesApi } from "../../../client/src/files.ts"
import type { TerminalSummary } from "../../../client/src/terminal.ts"
import { i18n } from "../i18n/index.ts"
import { selectOption } from "../test/controls.ts"
import { useRouteWorktree } from "../composables/useRouteWorktree.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../test/desktop-media.ts"
import RemoteControlView from "./RemoteControlView.vue"

const TerminalStub = defineComponent({
  name: "TerminalWorkspace", props: ["activeId", "terminals", "create"], emits: ["update:activeId"],
  template: '<div data-tool="terminal" />',
})
const DesktopStub = defineComponent({ name: "DesktopView", props: ["machineId"], template: '<div data-tool="desktop" />' })
const FilesStub = defineComponent({ name: "FileTransferPanel", props: ["api", "target", "machineName"], template: '<div data-tool="files" />' })
const SystemStub = defineComponent({ name: "SystemStatusPanel", props: ["machineId", "machineName", "online", "active"], template: '<div data-tool="system" />' })
const shell: TerminalSummary = { id: "shell", title: "zsh", cwd: "/workspace", cols: 80, rows: 24, status: "running" }
const originalFiles = platformClient.files
const originalDesktop = platformClient.desktop
const originalTarget = platformClient.target
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  platformClient.files = originalFiles
  platformClient.desktop = originalDesktop
  platformClient.target = originalTarget
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(options: { local?: boolean; desktop?: boolean; machineId?: string; query?: LocationQueryRaw; sessions?: TerminalSummary[]; realDesktop?: boolean; legacyDesktop?: boolean } = {}) {
  const files: FilesApi = {
    list: vi.fn(async () => { throw new Error("Unexpected file listing") }),
    chooseLocalDirectory: vi.fn(async () => null), enqueue: vi.fn(async () => "transfer"), transfers: vi.fn(async () => []),
    cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), onChanged: vi.fn(() => () => {}),
    resolveResource: vi.fn(async () => { throw new Error("Unexpected resource resolution") }),
    readResource: vi.fn(async () => { throw new Error("Unexpected resource read") }), saveResource: vi.fn(async () => null),
  }
  platformClient.files = files
  platformClient.target = reactive({ id: "local-daemon", local: options.local ?? false })
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  const terminals = useTerminalsStore()
  fleet.localDesktopTarget.desktop = options.desktop ?? false
  fleet.localDesktopTarget.online = true
  const other = { id: "other", name: "Other machine", local: false, online: true, desktop: false, terminals: [], sessions: [], workspaces: [] }
  const findMachine = fleet.findMachine
  vi.spyOn(fleet, "findMachine").mockImplementation(id => id === other.id ? other : findMachine(id))
  terminals.sessions = options.sessions ?? [shell]
  const create = vi.spyOn(terminals, "create")
  const router = createRouter({ history: createMemoryHistory(), routes: [{
    path: "/machines/:machineId/control", name: "machine-control", component: RemoteControlView, props: true,
  }, {
    path: "/machines/:machineId/desktop", name: "machine-desktop",
    redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "desktop" } }),
  }] })
  await router.push({ name: options.legacyDesktop ? "machine-desktop" : "machine-control", params: { machineId: options.machineId ?? fleet.targetId }, query: options.query })
  const host = defineComponent({ setup: () => ({ worktree: useRouteWorktree() }), template: "<RouterView />" })
  const wrapper = mount(host, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: {
      TerminalWorkspace: TerminalStub, DesktopView: options.realDesktop ? false : DesktopStub, FileTransferPanel: FilesStub,
      SystemStatusPanel: SystemStub,
    } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()
  return { wrapper, router, fleet, terminals, files, create }
}

const tabs = (wrapper: VueWrapper) => wrapper.findAll('[role="tab"]')
async function select(wrapper: VueWrapper, index: number) {
  await tabs(wrapper)[index]!.trigger("mousedown", { button: 0 })
  await flushPromises()
}

function mockDesktop() {
  stubWebRtc()
  const mock = mockDesktopApi()
  platformClient.desktop = mock.api
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
  const sources = new WeakMap<HTMLMediaElement, MediaProvider | null>()
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(function (this: HTMLMediaElement, value) {
    sources.set(this, value)
  })
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "get").mockImplementation(function (this: HTMLMediaElement) {
    return sources.get(this) ?? null
  })
  return mock
}

function connectButton(wrapper: VueWrapper) {
  return wrapper.findAll("[data-desktop-stage] button").find(button => button.text() === "Connect")!
}

test("a headless machine defaults to Terminal without mounting other tools", async () => {
  const { wrapper, create } = await setup()
  expect(tabs(wrapper).map(tab => tab.attributes("aria-selected"))).toEqual(["true", "false", "false", "false"])
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(true)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
  expect(create).not.toHaveBeenCalled()
})

test.each([
  { name: "the default route" },
  { name: "a desktop query", query: { tab: "desktop" } },
  { name: "the legacy desktop route", legacyDesktop: true },
])("the local machine hides Desktop and opens Terminal through $name", async options => {
  const { api } = mockDesktop()
  const { wrapper } = await setup({ ...options, local: true, desktop: true, realDesktop: true })
  expect(wrapper.text()).toContain("Local control")
  expect(tabs(wrapper).map(tab => tab.text())).toEqual(["Terminal", "File transfer", "System status"])
  expect(tabs(wrapper)[0]!.attributes("aria-selected")).toBe("true")
  expect(wrapper.getComponent(TerminalStub).props("terminals")).toEqual([shell])
  expect(wrapper.find("[data-desktop-stage]").exists()).toBe(false)
  expect(api.target).not.toHaveBeenCalled()
  expect(api.capabilities).not.toHaveBeenCalled()
  expect(api.offer).not.toHaveBeenCalled()
})

test("the local machine retains Terminal, File transfer, and System status", async () => {
  const { wrapper, router, fleet } = await setup({ local: true, desktop: true, query: { tab: "terminal", terminal: shell.id } })
  const terminal = wrapper.getComponent(TerminalStub)
  expect(terminal.props("activeId")).toBe(shell.id)
  await select(wrapper, 1)
  expect(router.currentRoute.value.query.tab).toBe("files")
  expect(wrapper.getComponent(FilesStub).isVisible()).toBe(true)
  await select(wrapper, 2)
  expect(wrapper.getComponent(SystemStub).props()).toMatchObject({ machineId: fleet.targetId, active: true, online: true })
  await select(wrapper, 0)
  expect(wrapper.getComponent(TerminalStub).vm).toBe(terminal.vm)
  expect(terminal.isVisible()).toBe(true)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
})

test("recognizing the current target as local removes its visited Desktop and selects Terminal", async () => {
  const { wrapper } = await setup({ desktop: true, query: { tab: "desktop" } })
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(true)
  platformClient.target!.local = true
  await flushPromises()
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.getComponent(TerminalStub).isVisible()).toBe(true)
  expect(tabs(wrapper).map(tab => tab.text())).toEqual(["Terminal", "File transfer", "System status"])
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

test.each([{ tab: 0, name: "Terminal" }, { tab: 2, name: "Files" }, { tab: 3, name: "System status" }])(
  "switching to $name disconnects Desktop and returning preserves settings until manually reconnecting",
  async ({ tab }) => {
    const { api, listeners } = mockDesktop()
    const { wrapper } = await setup({ desktop: true, realDesktop: true })
    await vi.waitFor(() => expect(wrapper.find("[data-desktop-stage]").exists()).toBe(true))
    await flushPromises()
    await wrapper.get('[aria-label="Stream settings"]').trigger("click"); await flushPromises()
    await selectOption(wrapper, '[role="combobox"][aria-label="Display"]', "Display 2 · 2560 × 1440")
    await wrapper.get('[role="checkbox"]').trigger("click")
    await wrapper.get("[data-desktop-control]").trigger("click")
    await wrapper.get('[aria-label="Stream settings"]').trigger("click"); await flushPromises()
    await connectButton(wrapper).trigger("click")
    await flushPromises()
    const peer = TestPeer.instances[0]!
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack
    peer.ontrack?.({ track })
    peer.changeState("connected")
    peer.input.ready()
    await flushPromises()
    const video = wrapper.get("video")
    const element = video.element as HTMLVideoElement
    expect(element.srcObject).not.toBeNull()
    await video.trigger("keydown", { code: "ControlLeft" })
    expect(peer.input.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "key", code: "ControlLeft", pressed: true, repeat: false }))

    await select(wrapper, tab)
    expect(api.close).toHaveBeenCalledExactlyOnceWith(api.offer.mock.calls[0]![0].sessionId)
    expect(peer.close).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.input.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "releaseAll" }))
    expect(peer.input.close).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    expect(element.srcObject).toBeNull()
    expect(video.isVisible()).toBe(false)

    await select(wrapper, 1)
    expect(wrapper.get("video").element).toBe(element)
    await wrapper.get('[aria-label="Stream settings"]').trigger("click"); await flushPromises()
    expect(wrapper.get('[role="combobox"][aria-label="Display"]').text()).toContain("Display 2")
    expect(wrapper.get('[role="checkbox"]').attributes("aria-checked")).toBe("true")
    expect(wrapper.get("[data-desktop-control]").attributes("aria-checked")).toBe("true")
    await wrapper.get('[aria-label="Stream settings"]').trigger("click"); await flushPromises()
    expect(connectButton(wrapper).attributes("disabled")).toBeUndefined()
    expect(api.offer).toHaveBeenCalledOnce()
    expect(api.start).toHaveBeenCalledOnce()
    await connectButton(wrapper).trigger("click")
    await flushPromises()
    expect(api.offer).toHaveBeenCalledTimes(2)
    expect(api.offer).toHaveBeenLastCalledWith(expect.objectContaining({ audio: true }))
  },
)

test("leaving Desktop during negotiation closes the peer and ignores a late answer", async () => {
  const { api } = mockDesktop()
  const answer = deferred<{ sdp: string }>()
  api.offer.mockReturnValueOnce(answer.promise)
  const { wrapper } = await setup({ desktop: true, realDesktop: true })
  await vi.waitFor(() => expect(wrapper.find("[data-desktop-stage]").exists()).toBe(true))
  await flushPromises()
  await connectButton(wrapper).trigger("click")
  await flushPromises()
  const peer = TestPeer.instances[0]!
  const sessionId = api.offer.mock.calls[0]![0].sessionId
  await select(wrapper, 2)
  expect(peer.close).toHaveBeenCalledOnce()
  expect(api.close).toHaveBeenCalledExactlyOnceWith(sessionId)

  answer.resolve({ sdp: "late-answer" })
  await flushPromises()
  expect(api.close).toHaveBeenCalledTimes(2)
  expect(api.close).toHaveBeenLastCalledWith(sessionId)
  expect(peer.setRemoteDescription).not.toHaveBeenCalled()
  expect(api.start).not.toHaveBeenCalled()
  await select(wrapper, 1)
  expect(api.offer).toHaveBeenCalledOnce()
  expect(connectButton(wrapper).attributes("disabled")).toBeUndefined()
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

test("machine control never exposes Worktree changes when switching tools", async () => {
  const { wrapper } = await setup({ query: { tab: "terminal", terminal: shell.id } })
  expect(wrapper.vm.worktree).toBeNull()
  await select(wrapper, 2)
  expect(wrapper.vm.worktree).toBeNull()
  await select(wrapper, 1)
  expect(wrapper.vm.worktree).toBeNull()
})

test.each([
  { desktop: false, selected: 0 },
  { desktop: true, selected: 1 },
])("an invalid tab selects the default tool without exposing Worktree changes (desktop=$desktop)", async ({ desktop, selected }) => {
  const { wrapper } = await setup({ desktop, query: { tab: "invalid", terminal: shell.id } })
  expect(tabs(wrapper)[selected]!.attributes("aria-selected")).toBe("true")
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
    expect(router.currentRoute.value.query.tab).toBe(["terminal", "desktop", "files", "system"][expected])
  }
  await move(0, "ArrowLeft", 3)
  await move(3, "ArrowRight", 0)
  await move(0, "End", 3)
  await move(3, "Home", 0)
  await move(0, "ArrowRight", 1)
})

test("an unknown machine mounts no tools", async () => {
  const { wrapper, create, files } = await setup({ machineId: "missing", query: { tab: "files" } })
  expect(tabs(wrapper)).toHaveLength(0)
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
  expect(create).not.toHaveBeenCalled()
  expect(files.list).not.toHaveBeenCalled()
})

test("a machine outside the current adapter cannot start tools against the current machine", async () => {
  const target = vi.spyOn(platformClient.desktop, "target")
  const capabilities = vi.spyOn(platformClient.desktop, "capabilities")
  const offer = vi.spyOn(platformClient.desktop, "offer")
  const { wrapper, create, files } = await setup({ machineId: "other", realDesktop: true })
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  await select(wrapper, 2)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  await select(wrapper, 3)
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
  await select(wrapper, 1)
  await vi.waitFor(() => expect(wrapper.find("[data-desktop-stage]").exists()).toBe(true))
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
  await select(wrapper, 3)
  await router.push({ name: "machine-control", params: { machineId: "other" } })
  await flushPromises()
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
  await router.push({ name: "machine-control", params: { machineId: fleet.targetId } })
  await flushPromises()
  expect(wrapper.getComponent(TerminalStub).vm).not.toBe(terminal)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
})

test("System status mounts on demand and follows tab visibility and machine presence", async () => {
  const { wrapper, fleet, router } = await setup()
  expect(wrapper.findComponent(SystemStub).exists()).toBe(false)
  await select(wrapper, 3)
  const system = wrapper.getComponent(SystemStub)
  const instance = system.vm
  expect(router.currentRoute.value.query.tab).toBe("system")
  expect(system.props()).toMatchObject({
    machineId: fleet.targetId, machineName: fleet.localDesktopTarget.name, online: true, active: true,
  })
  expect(wrapper.vm.worktree).toBeNull()
  await select(wrapper, 0)
  expect(system.props("active")).toBe(false)
  expect(system.isVisible()).toBe(false)
  await select(wrapper, 3)
  expect(wrapper.getComponent(SystemStub).vm).toBe(instance)
  expect(system.props("active")).toBe(true)
  fleet.localDesktopTarget.online = false
  await flushPromises()
  expect(system.props("online")).toBe(false)
})

test("the system query opens System status directly without mounting other tools", async () => {
  const { wrapper } = await setup({ query: { tab: "system" } })
  expect(wrapper.getComponent(SystemStub).props("active")).toBe(true)
  expect(wrapper.findComponent(TerminalStub).exists()).toBe(false)
  expect(wrapper.findComponent(DesktopStub).exists()).toBe(false)
  expect(wrapper.findComponent(FilesStub).exists()).toBe(false)
})
