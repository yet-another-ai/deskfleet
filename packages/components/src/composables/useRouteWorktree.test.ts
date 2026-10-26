import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { defineComponent } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import { useFleetStore } from "../stores/fleet.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { agentSnapshot } from "../test/agent.ts"
import { catalogFixture, mainWorktreeId, sessionId, sessionWorktreeId, workspaceId } from "../test/catalog.ts"
import { useRouteWorktree } from "./useRouteWorktree.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  vi.restoreAllMocks()
})

async function setup() {
  const pinia = createPinia()
  const fleet = useFleetStore(pinia)
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
  await fleet.refreshLocalCatalog()
  useTerminalsStore(pinia).sessions = [
    { id: "session-terminal", title: "shell", cwd: "/worktrees/api/session", cols: 80, rows: 24, status: "running", worktreeId: sessionWorktreeId },
    { id: "machine-terminal", title: "shell", cwd: "/worktrees/api/session", cols: 80, rows: 24, status: "running" },
  ]
  useAgentSessionsStore(pinia).sessions["pending-session"] = { ...agentSnapshot().session, id: "pending-session", workspaceId, lifecycle: "provisioning" }
  // The live terminal API has no workspace scope; keep this route-level fixture explicit.
  const findTerminal = fleet.findTerminal
  vi.spyOn(fleet, "findTerminal").mockImplementation(id => id === "workspace-terminal" ? {
    ...fleet.findWorkspace(workspaceId)!, terminal: { id, title: "shell", cwd: "/worktrees/api/session" },
  } : findTerminal(id))
  const page = defineComponent({ template: "<div />" })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: page },
    { path: "/workspaces/:workspaceId", name: "workspace", component: page },
    { path: "/worktrees/:worktreeId", name: "worktree", component: page },
    { path: "/sessions/:sessionId", name: "session", component: page },
    { path: "/terminals/:terminalId", name: "terminal", component: page },
    { path: "/machines/:machineId/control", name: "machine-control", component: page },
  ] })
  await router.push("/")
  const host = defineComponent({ setup: () => ({ worktree: useRouteWorktree() }), template: "<RouterView />" })
  const wrapper = mount(host, { global: { plugins: [pinia, router] } })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  return { wrapper, router, fleet }
}

test("Git context follows the session, worktree, and its terminal through repeated page switching", async () => {
  const { wrapper, router } = await setup()
  for (let pass = 0; pass < 2; pass++) {
    for (const path of [`/sessions/${sessionId}`, `/worktrees/${sessionWorktreeId}`, "/terminals/session-terminal"]) {
      await router.push(path)
      await flushPromises()
      expect(wrapper.vm.worktree).toMatchObject({ session: { id: sessionId }, worktree: { id: sessionWorktreeId } })
    }
    await router.push(`/workspaces/${workspaceId}`)
    expect(wrapper.vm.worktree).toBeNull()
  }
})

test("unowned, missing, and provisioning resources never inherit the previous Git context", async () => {
  const { wrapper, router, fleet } = await setup()
  for (const path of [
    "/", `/workspaces/${workspaceId}`, `/worktrees/${mainWorktreeId}`, "/worktrees/missing",
    "/sessions/missing", "/sessions/pending-session", "/terminals/missing", "/terminals/workspace-terminal",
    "/terminals/machine-terminal", "/machines/local-daemon/control?tab=terminal&terminal=session-terminal",
  ]) {
    await router.push(`/sessions/${sessionId}`)
    expect(wrapper.vm.worktree?.worktree.id).toBe(sessionWorktreeId)
    await router.push(path)
    expect(wrapper.vm.worktree).toBeNull()
  }
  await router.push(`/sessions/${sessionId}`)
  const workspace = fleet.catalog!.workspaces[0]!
  workspace.worktrees = workspace.worktrees.filter(worktree => worktree.sessionId === undefined)
  expect(wrapper.vm.worktree).toBeNull()
})
