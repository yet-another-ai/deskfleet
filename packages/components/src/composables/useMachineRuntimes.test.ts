import { flushPromises } from "@vue/test-utils"
import { getClient } from "@deskfleet/client/platform"
import { createPinia, disposePinia } from "pinia"
import { defineComponent, effectScope, h, nextTick } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { useAppearanceStore } from "../stores/appearance.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { agentSnapshot } from "../test/agent.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { createAccountSession } from "./useAccountSession.ts"
import { createMachineRuntimes, type MachineRuntime } from "./useMachineRuntimes.ts"
import { usePlatformClient } from "./usePlatformClient.ts"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function fixture() {
  const first = machineFixture("m1", "team-1", "First", false)
  const second = machineFixture("m2", "team-1", "Second", false)
  const fake = fakeCentral({ machines: [first, second] })
  const createPeer = vi.fn(async (_teamId: string, machineId: string) => ({
    peerId: `peer-${machineId}`,
    authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    iceServers: [],
  }))
  const closePeer = vi.fn(async (_id: string) => {})
  const catalog = vi.fn(async (machineId: string) => ({
    machineId,
    lastObservedAt: "2026-10-29T00:00:00Z",
    snapshot: {
      teamId: "1", machineId: "1", machineName: machineId,
      workspaces: [{ id: "20", name: `Workspace ${machineId}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }] }],
      sessions: [],
    },
  }))
  Object.assign(fake.central, { createPeer, closePeer, catalog, sessions: vi.fn(async () => []) })
  const session = createAccountSession(fake.central)
  await flushPromises()
  const state = createPinia()
  const scope = effectScope()
  const runtimes = scope.run(() => createMachineRuntimes(getClient(), session, useAppearanceStore(state)))!
  cleanups.push(() => { scope.stop(); session.dispose(); disposePinia(state) })
  return { ...fake, first, second, session, scope, runtimes, createPeer, closePeer, catalog }
}

function mountFleet(runtime: MachineRuntime) {
  let fleet!: ReturnType<typeof useFleetStore>
  let api!: ReturnType<typeof usePlatformClient>
  const root = document.createElement("div")
  document.body.append(root)
  const unmount = runtime.mount(defineComponent({
    setup() {
      api = usePlatformClient()
      fleet = useFleetStore()
      return () => h("p", fleet.catalog?.machineName)
    },
  }), root)
  cleanups.push(() => { unmount(); root.remove() })
  return { fleet, api, root, unmount }
}

test("changing the selected machine retains each opened machine's stores, adapter, and peer", async () => {
  const f = await fixture()
  const first = f.runtimes.open(f.first)
  const view = mountFleet(first)
  await view.fleet.refreshLocal()
  view.fleet.toggleMachine("m1")
  await first.api.agent.prepare!("same-local-peer")

  view.unmount()
  f.session.selectMachine("m2")
  const second = f.runtimes.open(f.second)
  const next = mountFleet(second)
  await next.fleet.refreshLocal()
  await second.api.agent.prepare!("same-local-peer")

  expect(f.runtimes.opened.size).toBe(2)
  expect(view.api).toBe(first.api)
  expect(next.api).toBe(second.api)
  expect(next.api).not.toBe(view.api)
  expect(view.fleet.targetId).toBe("m1")
  expect(next.fleet.targetId).toBe("m2")
  expect(view.fleet.findWorkspace("20")?.workspace.name).toBe("Workspace m1")
  expect(next.fleet.findWorkspace("20")?.workspace.name).toBe("Workspace m2")
  expect(next.fleet.isCollapsed("m2")).toBe(false)
  expect(f.closePeer).not.toHaveBeenCalled()

  f.session.selectMachine("m1")
  expect(f.runtimes.open(f.first)).toBe(first)
  const restored = mountFleet(first)
  expect(restored.fleet).toBe(view.fleet)
  expect(restored.fleet.isCollapsed("m1")).toBe(true)
  expect(f.createPeer).toHaveBeenCalledTimes(2)
  expect(f.closePeer).not.toHaveBeenCalled()
})

test("a background catalog event refreshes its owning machine after another machine is selected", async () => {
  const f = await fixture()
  const first = mountFleet(f.runtimes.open(f.first))
  await first.fleet.refreshLocal()
  f.session.selectMachine("m2")
  const second = mountFleet(f.runtimes.open(f.second))
  await second.fleet.refreshLocal()
  f.catalog.mockClear()

  f.emit({ type: "catalogChanged", machineId: "m1" })
  await flushPromises()

  expect(f.catalog).toHaveBeenCalledWith("m1")
  expect(f.catalog.mock.calls.every(([machineId]) => machineId === "m1")).toBe(true)
  expect(first.fleet.catalog?.machineName).toBe("m1")
  expect(second.fleet.catalog?.machineName).toBe("m2")
  expect(f.session.machineId.value).toBe("m2")
})

test("reconnect refreshes every retained catalog and conversation when roster metadata is unchanged", async () => {
  const f = await fixture()
  let revision = 0
  const snapshot = (machineId: string) => {
    const value = agentSnapshot()
    value.session.title = `Conversation ${machineId} revision ${revision}`
    return value
  }
  f.catalog.mockImplementation(async machineId => ({
    machineId, lastObservedAt: "2026-10-29T00:00:00Z",
    snapshot: {
      teamId: "1", machineId: "1", machineName: machineId === "m1" ? f.first.name : f.second.name,
      workspaces: [{ id: "20", name: `Workspace ${machineId} revision ${revision}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }] }],
      sessions: [],
    },
  }))
  Object.assign(f.central, {
    sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]),
    session: vi.fn(async (machineId: string) => ({ snapshot: snapshot(machineId) })),
    events: vi.fn(async () => ({ events: [] })),
  })
  const first = f.runtimes.open(f.first)
  const firstView = mountFleet(first)
  const firstAgents = useAgentSessionsStore(first.state)
  await firstView.fleet.refreshLocal()
  await firstAgents.refresh()
  await firstAgents.open("30")
  firstAgents.drafts["30"] = "Keep this draft"
  await first.api.agent.prepare!("retained-peer")
  firstView.unmount()
  f.session.selectMachine("m2")
  const second = f.runtimes.open(f.second)
  const secondView = mountFleet(second)
  const secondAgents = useAgentSessionsStore(second.state)
  await secondView.fleet.refreshLocal()
  await secondAgents.refresh()
  await secondAgents.open("30")
  await second.api.agent.prepare!("retained-peer")

  f.emit({ type: "connection", connected: false })
  revision++
  f.catalog.mockClear()
  f.emit({ type: "connection", connected: true })
  await flushPromises()

  expect(f.catalog).toHaveBeenCalledWith("m1")
  expect(f.catalog).toHaveBeenCalledWith("m2")
  expect(firstView.fleet.findWorkspace("20")?.workspace.name).toBe("Workspace m1 revision 1")
  expect(secondView.fleet.findWorkspace("20")?.workspace.name).toBe("Workspace m2 revision 1")
  expect(firstAgents.sessions["30"]?.title).toBe("Conversation m1 revision 1")
  expect(secondAgents.sessions["30"]?.title).toBe("Conversation m2 revision 1")
  expect(firstAgents.views["30"]?.snapshot?.session.title).toBe("Conversation m1 revision 1")
  expect(secondAgents.views["30"]?.snapshot?.session.title).toBe("Conversation m2 revision 1")
  expect(firstAgents.drafts["30"]).toBe("Keep this draft")
  expect(f.session.machineId.value).toBe("m2")
  expect(f.runtimes.opened.get("m1")).toBe(first)
  expect(f.runtimes.opened.get("m2")).toBe(second)
  expect(f.createPeer).toHaveBeenCalledTimes(2)
  expect(f.closePeer).not.toHaveBeenCalled()
})

test("a roster refresh reconciles an inactive machine after missed presence without closing its peer", async () => {
  const f = await fixture()
  const first = f.runtimes.open(f.first)
  const changed = vi.fn()
  first.api.catalog.onChanged(changed)
  await first.api.agent.prepare!("retained-peer")
  f.session.selectMachine("m2")
  f.runtimes.open(f.second)
  f.emit({ type: "connection", connected: false })
  Object.assign(f.state.machines[0]!, { online: true, name: "Renamed first", lastSeenAt: "2026-10-29T12:00:00Z" })
  f.emit({ type: "connection", connected: true })
  await flushPromises()

  expect(f.session.machineId.value).toBe("m2")
  expect(f.runtimes.opened.get("m1")).toBe(first)
  expect(first.api.agent.history!.available()).toBe(true)
  expect(await first.api.desktop.target()).toMatchObject({ name: "Renamed first", online: true })
  expect(first.api.target!.lastSeen).toBe("2026-10-29T12:00:00Z")
  expect(changed).toHaveBeenCalledTimes(2)
  expect(f.closePeer).not.toHaveBeenCalled()
  await f.session.refreshMachines()
  await flushPromises()
  expect(changed).toHaveBeenCalledTimes(2)

  // Both the direct event and the account's in-place roster update reach this
  // adapter, but the catalog needs only one refresh for the presence change.
  f.emit({ type: "presence", machineId: "m1", online: false })
  await flushPromises()
  expect(first.api.agent.history!.available()).toBe(false)
  expect(changed).toHaveBeenCalledTimes(3)
  expect(f.closePeer).not.toHaveBeenCalled()
})

test("removing an opened machine releases only its own peer and stores", async () => {
  const f = await fixture()
  const first = f.runtimes.open(f.first)
  const second = f.runtimes.open(f.second)
  await first.api.agent.prepare!("same-local-peer")
  await second.api.agent.prepare!("same-local-peer")

  await f.session.removeMachine("m1")
  await nextTick()

  expect([...f.runtimes.opened.keys()]).toEqual(["m2"])
  expect(f.closePeer).toHaveBeenCalledExactlyOnceWith("peer-m1")
  expect(f.runtimes.open(f.second)).toBe(second)
  const events = vi.fn()
  second.api.agent.onEvent(events)
  f.emit({ type: "peerRevoked", peerId: "peer-m2", reason: "revoked" })
  expect(events).toHaveBeenCalledWith({ sessionId: "same-local-peer", kind: "error", error: "revoked" })
})

test.each(["team", "sign-out", "shell"] as const)("leaving the %s scope releases all retained machine peers and views", async reason => {
  const f = await fixture()
  const first = f.runtimes.open(f.first)
  const second = f.runtimes.open(f.second)
  const firstView = mountFleet(first)
  const secondView = mountFleet(second)
  await first.api.agent.prepare!("same-local-peer")
  await second.api.agent.prepare!("same-local-peer")

  if (reason === "team") await f.session.selectTeam("team-2")
  else if (reason === "sign-out") await f.session.signOut()
  else f.scope.stop()
  await flushPromises()

  expect(f.runtimes.opened.size).toBe(0)
  expect(firstView.root.childElementCount).toBe(0)
  expect(secondView.root.childElementCount).toBe(0)
  expect(f.closePeer.mock.calls.map(([id]) => id).sort()).toEqual(["peer-m1", "peer-m2"])
  const events = vi.fn()
  first.api.agent.onEvent(events)
  f.emit({ type: "peerRevoked", peerId: "peer-m1", reason: "revoked" })
  expect(events).not.toHaveBeenCalled()
})
