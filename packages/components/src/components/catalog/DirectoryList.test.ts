import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import DirectoryList from "./DirectoryList.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.restoreAllMocks() })

async function setup(owner?: { sessionId: string; worktreeId: string }) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const terminals = useTerminalsStore()
  const create = vi.spyOn(terminals, "create").mockResolvedValue({
    id: "created-shell", title: "zsh", cwd: "/workspace", cols: 80, rows: 24, status: "running",
  })
  const layout = useLayoutStore()
  layout.terminalPanelOpen = false
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { template: "<div />" } }] })
  await router.push("/")
  const navigate = vi.spyOn(router, "push").mockResolvedValue()
  const wrapper = mount(DirectoryList, {
    props: { directories: [{ path: "/workspace" }], defaultAction: true, owner },
    global: { plugins: [pinia, router, i18n] },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  return { wrapper, create, navigate, layout }
}

test("a Workspace directory creates a machine shell at its cwd and opens the unified terminal tab", async () => {
  const { wrapper, create, navigate, layout } = await setup()
  await wrapper.get("button").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace", worktreeId: undefined })
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    name: "machine-control", params: { machineId: "local-daemon" }, query: { tab: "terminal", terminal: "created-shell" },
  })
  expect(layout.terminalPanelOpen).toBe(false)
})

test("a Session directory retains its Worktree ownership and opens the Session terminal panel", async () => {
  const { wrapper, create, navigate, layout } = await setup({ sessionId: "session", worktreeId: "worktree" })
  await wrapper.get('button[aria-label]').trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace", worktreeId: "worktree" })
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ name: "session", params: { sessionId: "session" } })
  expect(layout.terminalPanelOpen).toBe(true)
})
