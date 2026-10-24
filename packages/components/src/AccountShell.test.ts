import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import AccountShell from "./AccountShell.vue"
import { agentEvent, agentInput, agentSnapshot } from "./test/agent.ts"

const host = getClient()
let view: VueWrapper | undefined
afterEach(async () => { view?.unmount(); view = undefined; configureClient(host); await router.replace("/"); vi.restoreAllMocks() })

test("browses synchronized history with the machine offline and isolates equal local IDs when switching machines", async () => {
  const listeners = new Set<(event: CentralEvent) => void>()
  const machines: Machine[] = ["First", "Second"].map((name, index) => ({ id: String(index + 101), teamId: "7", name, localMachineId: "1", originId: `origin-${index}`, online: false, capabilities: {} }))
  const snapshot = (machineId: string) => {
    const value = agentSnapshot()
    value.session.title = `Conversation ${machineId}`
    value.session.workspaceId = "20"
    value.session.lastEventSeq = "1"
    value.inputs = [agentInput({ content: [{ type: "text", text: `Message from ${machineId}` }] })]
    return value
  }
  const central = {
    status: vi.fn(async () => ({ serverUrl: "https://fleet.example", user: { id: "u1", name: "Ada" } })),
    teams: vi.fn(async () => [{ id: "7", name: "Team", role: "member" }]),
    machines: vi.fn(async () => machines),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    catalog: vi.fn(async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T00:00:00Z", providers: { providers: [{ id: "codex", name: "Codex", template: "codex" }] }, snapshot: {
      teamId: "1", machineId: "1", machineName: machines.find(machine => machine.id === machineId)!.name,
      workspaces: [{ id: "20", name: `Workspace ${machineId}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }, { id: "31", workspaceId: "20", sessionId: "30", directories: [{ path: "/worktree" }] }] }],
    } })),
    sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]),
    session: vi.fn(async (machineId: string) => ({ snapshot: snapshot(machineId), lastEventSeq: "1", lastObservedAt: "2026-10-25T00:00:00Z" })),
    events: vi.fn(async (machineId: string) => ({ events: [agentEvent(1, "input", snapshot(machineId).inputs[0]!)], lastEventSeq: "1" })),
    rpc: vi.fn(async () => { throw new Error("Offline") }), createPeer: vi.fn(),
  } as unknown as CentralApi
  view = mount(AccountShell, { props: { host: { ...host, platform: "web", central } }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 101"))
  expect(view.text()).toContain("Conversation 101")
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 101"))
  expect(central.createPeer).not.toHaveBeenCalled()
  await view.get('select[aria-label="Machine"]').setValue("102"); await flushPromises()
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 102"))
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 102"))
  expect(view.text()).not.toContain("Message from 101")
  expect(central.createPeer).not.toHaveBeenCalled()
})
