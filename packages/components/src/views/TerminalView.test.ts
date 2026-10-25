import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../i18n/index.ts"
import { useFleetStore, type TerminalLocation } from "../stores/fleet.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import TerminalView from "./TerminalView.vue"

const terminal = { id: "shell", title: "zsh", cwd: "/workspace" }
const workspace = { id: "workspace", name: "workspace", directories: [{ path: terminal.cwd }], terminals: [], sessions: [] }
const worktree = { id: "worktree", directories: workspace.directories, terminals: [terminal] }
const machine = { id: "local-daemon", name: "host", local: true, online: true, desktop: false, terminals: [terminal], workspaces: [workspace] }
const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.restoreAllMocks() })

async function setup(location: TerminalLocation | null, pendingRedirect = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  vi.spyOn(fleet, "findTerminal").mockReturnValue(location)
  const terminals = useTerminalsStore()
  const layout = useLayoutStore()
  layout.terminalPanelOpen = false
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { template: "<div />" } }] })
  await router.push("/")
  const navigate = vi.spyOn(router, "replace").mockResolvedValue()
  if (pendingRedirect) navigate.mockReturnValue(new Promise(() => {}))
  const wrapper = mount(TerminalView, {
    props: { terminalId: terminal.id },
    global: { plugins: [pinia, router, i18n], stubs: { TerminalWorkspace: true, TerminalSurface: true } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()
  return { wrapper, navigate, terminals, layout }
}

test("a machine-owned terminal opens Remote Control even when its cwd is a workspace directory", async () => {
  const { navigate, layout } = await setup({ machine, terminal })
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    name: "machine-control", params: { machineId: machine.id }, query: { tab: "terminal", terminal: terminal.id },
  })
  expect(layout.terminalPanelOpen).toBe(false)
})

test("a Session-owned terminal opens its Session panel and selects the original shell", async () => {
  const session = { id: "session", worktree }
  const { navigate, terminals, layout } = await setup({ machine, workspace, session, worktree, terminal })
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ name: "session", params: { sessionId: session.id } })
  expect(terminals.selected[worktree.id]).toBe(terminal.id)
  expect(layout.terminalPanelOpen).toBe(true)
})

test("a workspace-owned terminal keeps its existing route", async () => {
  const { wrapper, navigate } = await setup({ machine, workspace, terminal })
  expect(navigate).not.toHaveBeenCalled()
  expect(wrapper.findComponent({ name: "TerminalWorkspace" }).exists()).toBe(true)
})

test("an unknown terminal does not redirect to an unrelated machine", async () => {
  const { navigate } = await setup(null)
  expect(navigate).not.toHaveBeenCalled()
})

test.each([
  { scope: "machine", location: { machine, terminal } },
  { scope: "Session", location: { machine, workspace, worktree, session: { id: "session", worktree }, terminal } },
])("a $scope redirect never mounts a temporary live terminal while navigation is pending", async ({ location }) => {
  const { wrapper, navigate } = await setup(location, true)
  expect(navigate).toHaveBeenCalledOnce()
  expect(wrapper.findComponent({ name: "TerminalWorkspace" }).exists()).toBe(false)
  expect(wrapper.findComponent({ name: "TerminalSurface" }).exists()).toBe(false)
})
