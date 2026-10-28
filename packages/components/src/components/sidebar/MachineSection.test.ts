import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import MachineSection from "./MachineSection.vue"

async function setup(machine: Partial<MachineSummary> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/workspaces/:workspaceId", name: "workspace", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
    ],
  })
  await router.push("/machines/local-daemon/control?tab=files")
  const wrapper = mount(MachineSection, {
    props: { machine: {
      id: "local-daemon", name: "host", local: true, online: true, desktop: false,
      terminals: [{ id: "shell", title: "Machine shell", cwd: "/home/user" }], sessions: [], workspaces: [], ...machine,
    } },
    global: { plugins: [pinia, router, i18n] },
  })
  return { wrapper, router }
}

test.each([
  { local: true, desktop: true, label: "Local control" },
  { local: true, desktop: false, label: "Local control" },
  { local: false, desktop: true, label: "Remote control" },
  { local: false, desktop: false, label: "Remote control" },
])("machines expose one control entry with local=$local and desktop=$desktop", async ({ local, desktop, label }) => {
  const { wrapper, router } = await setup({ local, desktop })
  const links = wrapper.findAll("a")
  expect(links.map(link => link.text())).toEqual([label])
  expect(wrapper.text().includes("This machine")).toBe(local)
  expect(links[0]!.attributes("href")).toBe("/machines/local-daemon/control")
  expect(links[0]!.attributes("aria-current")).toBe("page")
  expect(wrapper.find('[title="New terminal"]').exists()).toBe(false)
  await router.push("/machines/local-daemon/control?tab=terminal&terminal=shell")
  expect(links[0]!.attributes("aria-current")).toBe("page")
  wrapper.unmount()
})

test("new session buttons select their workspace, including from the creation page", async () => {
  const { wrapper, router } = await setup({
    workspaces: ["first", "second"].map(id => ({ id, name: id, directories: [{ path: `/${id}` }], sessions: [], terminals: [] })),
  })
  const fleet = useFleetStore()
  const folder = wrapper.get('button[aria-label="first"]')
  await folder.trigger("click")
  const buttons = wrapper.findAll('button[aria-label="New session"]')
  await buttons[0]!.trigger("click")
  await flushPromises()
  expect(fleet.targetWorkspaceId).toBe("first")
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(folder.attributes("aria-expanded")).toBe("false")
  await buttons[1]!.trigger("click")
  await flushPromises()
  expect(fleet.targetWorkspaceId).toBe("second")
  expect(router.currentRoute.value.name).toBe("new-session")
  wrapper.unmount()
})

test("workspace rows navigate while their icon buttons fold terminals and sessions", async () => {
  const { wrapper, router } = await setup({
    desktop: true,
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }],
      terminals: [{ id: "workspace-shell", title: "Workspace shell", cwd: "/project" }],
      sessions: [{ id: "session", title: "Implement feature", provider: "Codex" }],
    }],
  })
  expect(wrapper.findAll("a").map(link => [link.text(), link.attributes("href")])).toEqual([
    ["Local control", "/machines/local-daemon/control"],
    ["Project", "/workspaces/workspace"],
    ["Workspace shell", "/terminals/workspace-shell"],
    ["Implement feature", "/sessions/session"],
  ])
  const folder = wrapper.get('button[aria-label="Project"]')
  await wrapper.get('a[href="/workspaces/workspace"]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("workspace")
  expect(folder.attributes("aria-expanded")).toBe("true")
  const path = router.currentRoute.value.fullPath
  expect(folder.attributes("aria-expanded")).toBe("true")
  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('a[href="/sessions/session"]').exists()).toBe(false)
  expect(wrapper.find('a[href="/terminals/workspace-shell"]').exists()).toBe(false)
  expect(router.currentRoute.value.fullPath).toBe(path)
  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("true")
  expect(wrapper.get('a[href="/sessions/session"]').text()).toBe("Implement feature")
  expect(wrapper.get('a[href="/terminals/workspace-shell"]').text()).toBe("Workspace shell")
  expect(wrapper.text()).not.toContain("Machine shell")
  wrapper.unmount()
})
