import { client as platformClient } from "@deskfleet/client/platform"
import type { DesktopCapabilities } from "@deskfleet/client/desktop-media"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { router } from "../router/index.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../test/desktop-media.ts"
import RemoteDesktopsView from "./RemoteDesktopsView.vue"

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

async function setup(machines = [desktopMachine("remote"), desktopMachine("other")]) {
  const fake = fakeCentral({ machines, enrollment: { configured: true, connected: true, revoked: false, serverUrl: "https://fleet.example", machineId: "local", teamId: "team-1", identity: { originId: "origin-local", machineId: "1" }, machineName: "local" } })
  const account = createAccountSession(fake.central)
  await flushPromises()
  const adapters: Array<ReturnType<typeof mockDesktopApi> & { machineId: string; dispose: ReturnType<typeof vi.fn> }> = []
  vi.mocked(remoteMachineClient).mockImplementation((_host, _central, machine) => {
    const mock = { ...mockDesktopApi(), machineId: machine.id, dispose: vi.fn() }
    adapters.push(mock)
    return { api: { ...platformClient, desktop: mock.api }, dispose: mock.dispose, updateMachine: vi.fn(), refreshCatalog: vi.fn(), setLocal: vi.fn() }
  })
  const pinia = createPinia()
  cleanups.push(() => { account.dispose(); disposePinia(pinia) })
  const open = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const refresh = vi.spyOn(account, "refreshMachines").mockResolvedValue()
  wrapper = mount(RemoteDesktopsView, { global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } } })
  await flushPromises()
  return { account, adapters, open, refresh }
}

test("shows every remote display in the selected Team independently of the selected machine or Session", async () => {
  const current = await setup([desktopMachine("local"), desktopMachine("remote"), desktopMachine("other")])
  current.account.machines.value.push({ ...desktopMachine("foreign"), teamId: "team-2" })
  await flushPromises()
  expect(current.adapters.map(value => value.machineId)).toEqual(["remote", "other"])
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(4)
  expect(wrapper!.text()).not.toContain("Session machine")
  for (const id of ["remote", "other"]) {
    const cards = wrapper!.get(`[data-preview-machine="${id}"]`).findAll("[data-preview-display]")
    expect(cards.map(card => card.get("footer").text())).toEqual([
      expect.stringContaining(`${id}Display 1`), expect.stringContaining(`${id}Display 2`),
    ])
  }
  current.account.selectMachine("other")
  await flushPromises()
  expect(current.adapters).toHaveLength(2)
  await wrapper!.get('[data-preview-machine="other"] [data-preview-display="2"] button').trigger("click")
  expect(current.open).toHaveBeenCalledWith("other", { name: "machine-control", params: { machineId: "other" }, query: { tab: "desktop", display: "2", connect: "1" } })
})

test("pause, document visibility, and leaving the overview release its preview streams", async () => {
  const current = await setup()
  const initial = [...TestPeer.instances]
  expect(initial).toHaveLength(4)
  await wrapper!.get('button[aria-label="Pause previews"]').trigger("click")
  await flushPromises()
  for (const peer of initial) expect(peer.close).toHaveBeenCalledOnce()
  visibility = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  visibility = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(4)
  await wrapper!.get('button[aria-label="Resume previews"]').trigger("click")
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(8)
  visibility = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  for (const peer of TestPeer.instances) expect(peer.close).toHaveBeenCalledOnce()
  visibility = "visible"
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(TestPeer.instances).toHaveLength(12)
  wrapper!.unmount()
  wrapper = undefined
  await flushPromises()
  for (const peer of TestPeer.instances) expect(peer.close).toHaveBeenCalledOnce()
  for (const adapter of current.adapters) expect(adapter.dispose).toHaveBeenCalledOnce()
})

test("refresh discovers new displays, and removing a machine releases only its adapters", async () => {
  const current = await setup()
  const remote = current.adapters[0]!
  const capabilities = await remote.api.capabilities()
  remote.api.capabilities.mockResolvedValue({ ...capabilities, displays: capabilities.displays.slice(0, 1) })
  await wrapper!.get('button[aria-label="Refresh displays"]').trigger("click")
  await flushPromises()
  expect(current.refresh).toHaveBeenCalledOnce()
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(3)
  current.account.machines.value = current.account.machines.value.filter(machine => machine.id === "other")
  await flushPromises()
  expect(remote.dispose).toHaveBeenCalledOnce()
  expect(current.adapters[1]!.dispose).not.toHaveBeenCalled()
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(2)
})

test("changing Teams discards pending discovery and rebuilds previews with the new scope", async () => {
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

test("offline and unavailable machines keep their names beside their status", async () => {
  const current = await setup([desktopMachine("offline", false), { ...desktopMachine("headless"), capabilities: { desktop: false } }])
  expect(wrapper!.get('[data-preview-machine="offline"]').text()).toContain("offline")
  expect(wrapper!.get('[data-preview-machine="offline"]').text()).toContain("comes online")
  expect(wrapper!.get('[data-preview-machine="headless"]').text()).toContain("headless")
  expect(wrapper!.get('[data-preview-machine="headless"]').text()).toContain("Desktop capture is unavailable")
  for (const adapter of current.adapters) expect(adapter.api.capabilities).not.toHaveBeenCalled()
  current.account.machines.value[0]!.online = true
  await flushPromises()
  expect(wrapper!.findAll("[data-preview-display]")).toHaveLength(2)
})

test("shows the empty state when there are no remote machines", async () => {
  await setup([desktopMachine("local")])
  expect(wrapper!.text()).toContain("No remote machines yet")
  expect(wrapper!.findAll("[data-preview-machine]")).toHaveLength(0)
  expect(TestPeer.instances).toHaveLength(0)
})
