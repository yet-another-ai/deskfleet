import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import MachineSection from "./MachineSection.vue"

async function setup(machine: Partial<MachineSummary> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
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

test("machine tool consolidation preserves Workspace and Session navigation", async () => {
  const { wrapper } = await setup({
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
  expect(wrapper.text()).not.toContain("Machine shell")
  wrapper.unmount()
})
