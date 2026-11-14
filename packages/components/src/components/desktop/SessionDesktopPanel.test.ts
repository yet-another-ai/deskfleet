import { client as platformClient } from "@deskfleet/client/platform"
import type { DesktopCapabilities } from "@deskfleet/client/desktop-media"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../../test/desktop-media.ts"
import SessionDesktopPanel from "./SessionDesktopPanel.vue"

vi.mock("@deskfleet/client/remote", () => ({ remoteMachineClient: vi.fn() }))

const cleanups: (() => void)[] = []
let wrapper: VueWrapper | undefined
let visibility: DocumentVisibilityState
const desktopMachine = (id: string, online = true) => ({ ...machineFixture(id, "team-1", id, online), capabilities: { desktop: true } })

beforeEach(() => {
  stubWebRtc()
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
  const sources = new WeakMap<HTMLMediaElement, MediaProvider | null>()
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(function (this: HTMLMediaElement, value) { sources.set(this, value) })
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "get").mockImplementation(function (this: HTMLMediaElement) { return sources.get(this) ?? null })
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  await flushPromises()
  vi.unstubAllGlobals()
})

async function setup(machines = [desktopMachine("local"), desktopMachine("remote"), desktopMachine("offline", false)], active = true, displays?: DesktopCapabilities["displays"]) {
  const fake = fakeCentral({ machines, enrollment: { configured: true, connected: true, revoked: false, serverUrl: "https://fleet.example", machineId: "local", teamId: "team-1", identity: { originId: "origin-local", machineId: "1" }, machineName: "local" } })
  const account = createAccountSession(fake.central)
  await flushPromises()
  account.selectMachine(machines.find(machine => machine.id !== "local")?.id ?? "local")
  const adapters: Array<ReturnType<typeof mockDesktopApi> & { machineId: string; dispose: ReturnType<typeof vi.fn> }> = []
  vi.mocked(remoteMachineClient).mockImplementation((_host, _central, machine) => {
    const mock = { ...mockDesktopApi(), machineId: machine.id, dispose: vi.fn() }
    if (displays) mock.api.capabilities.mockResolvedValue({ displays, audio: false })
    adapters.push(mock)
    return { api: { ...platformClient, desktop: mock.api }, dispose: mock.dispose, updateMachine: vi.fn(), refreshCatalog: vi.fn(), setLocal: vi.fn() }
  })
  const pinia = createPinia()
  const fleet = useFleetStore(pinia)
  vi.spyOn(fleet, "findSession").mockImplementation(id => {
    const machine = machines.find(machine => id === `session-${machine.id}`)
    return machine ? { machine: { id: machine.id, name: machine.name, local: machine.id === "local", online: machine.online, desktop: true, sessions: [], workspaces: [], terminals: [] }, session: { id } } : null
  })
  cleanups.push(() => { account.dispose(); disposePinia(pinia) })
  const open = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  vi.spyOn(account, "refreshMachines").mockResolvedValue()
  const sessionId = `session-${machines.find(machine => machine.id !== "local")?.id ?? "local"}`
  wrapper = mount(SessionDesktopPanel, { props: { sessionId, active }, global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } } })
  await flushPromises()
  return { ...fake, account, adapters, open, fleet }
}

test("defaults to every display on the Session's machine with bounded, silent, read-only streams", async () => {
  const current = await setup()
  expect(wrapper!.find('[data-preview-machine="local"]').exists()).toBe(false)
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(2)
  const remote = current.adapters.find(value => value.machineId === "remote")!
  expect(current.adapters.map(value => value.machineId)).toEqual(["remote"])
  expect(remote.api.capabilities).toHaveBeenCalledOnce()
  expect(wrapper!.find('[data-preview-machine="offline"]').exists()).toBe(false)
  expect(TestPeer.instances).toHaveLength(2)
  expect(remote.api.offer.mock.calls.map(([options]) => options.codec)).toEqual(["h264", "h264"])
  for (const peer of TestPeer.instances) {
    expect(peer.createDataChannel).not.toHaveBeenCalled()
    expect(peer.addTransceiver.mock.calls.map(([kind]) => kind)).toEqual(["video"])
    peer.changeState("connected")
  }
  await flushPromises()
  expect(wrapper!.text()).not.toContain("1 fps")
  expect(remote.api.start.mock.calls.map(([options]) => options)).toEqual([1, 2].map(displayId => ({ sessionId: expect.any(String), displayId, fps: 1, bitrateBps: 150_000, maxWidth: 320, maxHeight: 180 })))
  await wrapper!.get('[data-preview-display="2"] button').trigger("click")
  expect(current.open).toHaveBeenCalledWith("remote", { name: "machine-control", params: { machineId: "remote" }, query: { tab: "desktop", display: "2", connect: "1" } })
})

test("previews show monitor metadata and list numbers while routing with opaque IDs", async () => {
  const current = await setup([desktopMachine("remote")], true, [
    { id: 65537, displayNumber: 1, name: "Dell U2723QE (DP-1)", width: 3840, height: 2160, refreshRateHz: 60, codecs: ["h264"] },
    { id: 65539, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264"] },
  ])
  const first = wrapper!.get('[data-preview-display="65537"]')
  const second = wrapper!.get('[data-preview-display="65539"]')
  expect(first.text()).toContain("Display 1 · Dell U2723QE (DP-1)")
  expect(first.get("button").attributes("aria-label")).toBe("Open remote, Display 1 · Dell U2723QE (DP-1)")
  expect(second.text()).toContain("Display 2")
  expect(second.text()).not.toContain("65539")
  await second.get("button").trigger("click")
  expect(current.open).toHaveBeenCalledWith("remote", { name: "machine-control", params: { machineId: "remote" }, query: { tab: "desktop", display: "65539", connect: "1" } })
})

test("switching to all machines adds previews and switching back releases only the other machines", async () => {
  const current = await setup([desktopMachine("local"), desktopMachine("remote"), desktopMachine("other"), desktopMachine("offline", false)])
  const originalPeers = [...TestPeer.instances]
  const currentButton = () => wrapper!.findAll("button").find(button => button.text() === "Session machine")!
  const allButton = () => wrapper!.findAll("button").find(button => button.text() === "All machines")!
  expect(currentButton().attributes("aria-pressed")).toBe("true")
  await allButton().trigger("click")
  await flushPromises()
  expect(allButton().attributes("aria-pressed")).toBe("true")
  expect(current.adapters.map(value => value.machineId)).toEqual(["remote", "other", "offline"])
  expect(wrapper!.find('[data-preview-machine="local"]').exists()).toBe(false)
  expect(wrapper!.get('[data-preview-machine="offline"]').text()).toContain("Offline")
  expect(current.adapters[2]!.api.capabilities).not.toHaveBeenCalled()
  expect(TestPeer.instances).toHaveLength(4)
  for (const peer of originalPeers) expect(peer.close).not.toHaveBeenCalled()
  await currentButton().trigger("click")
  await flushPromises()
  expect(wrapper!.findAll("[data-preview-machine]")).toHaveLength(1)
  expect(current.adapters[0]!.dispose).not.toHaveBeenCalled()
  expect(current.adapters[1]!.dispose).toHaveBeenCalledOnce()
  expect(current.adapters[2]!.dispose).toHaveBeenCalledOnce()
  for (const peer of TestPeer.instances.slice(2)) expect(peer.close).toHaveBeenCalledOnce()
  for (const peer of originalPeers) expect(peer.close).not.toHaveBeenCalled()
})

test("the Session owns the default scope independently of account navigation and new-session workspace selection", async () => {
  const current = await setup([desktopMachine("remote"), desktopMachine("other"), desktopMachine("local")])
  current.account.selectMachine("other")
  current.fleet.targetWorkspaceId = "unrelated-new-session-workspace"
  await flushPromises()
  expect(current.adapters).toHaveLength(1)
  expect(wrapper!.find('[data-preview-machine="remote"]').exists()).toBe(true)
  await wrapper!.setProps({ sessionId: "session-other" })
  await flushPromises()
  expect(current.adapters[0]!.dispose).toHaveBeenCalledOnce()
  expect(wrapper!.find('[data-preview-machine="other"]').exists()).toBe(true)
  await wrapper!.setProps({ sessionId: "session-local" })
  await flushPromises()
  expect(wrapper!.findAll("[data-preview-machine]")).toHaveLength(0)
  expect(wrapper!.text()).toContain("No remote desktop for this session")
  expect(current.adapters).toHaveLength(2)
  expect(current.adapters[1]!.dispose).toHaveBeenCalledOnce()
})

test("changing Sessions resets All machines and releases the previous previews", async () => {
  const current = await setup([desktopMachine("remote"), desktopMachine("other")])
  await wrapper!.findAll("button").find(button => button.text() === "All machines")!.trigger("click")
  await flushPromises()
  await wrapper!.setProps({ sessionId: "session-other" })
  await flushPromises()
  expect(wrapper!.findAll("[data-preview-machine]")).toHaveLength(1)
  expect(wrapper!.find('[data-preview-machine="other"]').exists()).toBe(true)
  expect(current.adapters[0]!.dispose).toHaveBeenCalledOnce()
  expect(current.adapters[1]!.dispose).toHaveBeenCalledOnce()
})

test("an unresolved Session never falls back to the account's selected machine", async () => {
  await setup([desktopMachine("remote")])
  await wrapper!.setProps({ sessionId: "missing-session" })
  await flushPromises()
  expect(wrapper!.findAll("[data-preview-machine]")).toHaveLength(0)
})

test("inactive tabs do not start previews, and hiding a visited tab closes its peers", async () => {
  const current = await setup([desktopMachine("remote")], false)
  expect(current.adapters[0]!.api.capabilities).not.toHaveBeenCalled()
  expect(TestPeer.instances).toHaveLength(0)
  await wrapper!.setProps({ active: true })
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(2)
  await wrapper!.setProps({ active: false })
  await flushPromises()
  for (const peer of TestPeer.instances) expect(peer.close).toHaveBeenCalledOnce()
  await wrapper!.setProps({ active: true })
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(4)
})

test("hidden pages release all preview peers and resume when visible", async () => {
  const current = await setup([desktopMachine("remote")])
  const firstPeers = [...TestPeer.instances]
  visibility = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  for (const peer of firstPeers) expect(peer.close).toHaveBeenCalledOnce()
  expect(current.adapters[0]!.api.close).toHaveBeenCalledTimes(2)
  visibility = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(4)
  wrapper!.unmount()
  wrapper = undefined
  await flushPromises()
  expect(current.adapters[0]!.dispose).toHaveBeenCalledOnce()
  for (const peer of TestPeer.instances) expect(peer.close).toHaveBeenCalledOnce()
})

test("manual pause stays paused across visibility changes", async () => {
  await setup([desktopMachine("remote")])
  await wrapper!.get('button[aria-label="Pause previews"]').trigger("click")
  await flushPromises()
  visibility = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  visibility = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(2)
  await wrapper!.get('button[aria-label="Resume previews"]').trigger("click")
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(4)
})

test("switching teams releases adapters and ignores late display discovery", async () => {
  const current = await setup([desktopMachine("remote")])
  const pending = deferred<DesktopCapabilities>()
  current.adapters[0]!.api.capabilities.mockReturnValueOnce(pending.promise)
  await wrapper!.get('button[aria-label="Refresh displays"]').trigger("click")
  current.account.teamId.value = "team-2"
  current.account.machines.value = [{ ...desktopMachine("remote"), teamId: "team-2", name: "Other team desktop" }]
  await flushPromises()
  expect(current.adapters[0]!.dispose).toHaveBeenCalledOnce()
  pending.resolve({ displays: [{ id: 99, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264"] }], audio: false })
  await flushPromises()
  expect(current.adapters).toHaveLength(2)
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(2)
  expect(wrapper!.find('[data-preview-display="99"]').exists()).toBe(false)
  expect(wrapper!.text()).toContain("Other team desktop")
})

test("a remote machine coming online discovers its displays", async () => {
  const current = await setup([desktopMachine("offline", false)])
  expect(TestPeer.instances).toHaveLength(0)
  current.account.machines.value[0]!.online = true
  await flushPromises()
  expect(current.adapters[0]!.api.capabilities).toHaveBeenCalledOnce()
  expect(TestPeer.instances).toHaveLength(2)
})

test("one failed preview can retry without interrupting the other display", async () => {
  const current = await setup([desktopMachine("remote")])
  const remote = current.adapters[0]!
  const firstSession = remote.api.offer.mock.calls[0]![0].sessionId
  const second = TestPeer.instances[1]!
  remote.emit({ sessionId: firstSession, kind: "error", error: "Display is unavailable" })
  await flushPromises()
  const failed = wrapper!.get('[data-preview-display="1"]')
  expect(failed.text()).toContain("Display is unavailable")
  expect(second.close).not.toHaveBeenCalled()
  await failed.findAll("button").find(button => button.text() === "Refresh displays")!.trigger("click")
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(3)
  expect(second.close).not.toHaveBeenCalled()
})
