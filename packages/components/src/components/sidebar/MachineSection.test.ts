import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import MachineSection from "./MachineSection.vue"

function setup(id = "local-daemon") {
  const pinia = createPinia()
  setActivePinia(pinia)
  const terminals = useTerminalsStore()
  const create = vi.spyOn(terminals, "create").mockResolvedValue({
    id: "terminal-real", title: "zsh", cwd: "/home/user", cols: 80, rows: 24, status: "running",
  })
  const navigate = vi.spyOn(router, "push").mockResolvedValue()
  const wrapper = mount(MachineSection, {
    props: { machine: { id, name: "host", local: id === "local-daemon", online: true, desktop: false, terminals: [], workspaces: [] } },
    global: { plugins: [pinia, router, i18n] },
  })
  return { wrapper, create, navigate }
}

afterEach(() => vi.restoreAllMocks())

test("the local machine opens a real terminal and navigates to its session", async () => {
  const { wrapper, create, navigate } = setup()
  await wrapper.get('[title="New terminal"]').trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledOnce()
  expect(navigate).toHaveBeenCalledWith({ name: "terminal", params: { terminalId: "terminal-real" } })
  wrapper.unmount()
})

test("sample machine controls never create a local shell", async () => {
  const { wrapper, create } = setup("machine-development-box")
  await wrapper.get('[title="New terminal (not available yet)"]').trigger("click")
  expect(create).not.toHaveBeenCalled()
  wrapper.unmount()
})

test("terminal creation failure stays visible and allows another attempt", async () => {
  const { wrapper, create } = setup()
  create.mockRejectedValueOnce(new Error("Daemon disconnected"))
  await wrapper.get('[title="New terminal"]').trigger("click")
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Daemon disconnected")
  expect(wrapper.get('[title="New terminal"]').attributes("aria-disabled")).toBeUndefined()
  wrapper.unmount()
})
