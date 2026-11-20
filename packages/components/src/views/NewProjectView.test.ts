import { getClient } from "@deskfleet/client/platform"
import { remoteMachineClient } from "@deskfleet/client/remote"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import type { CatalogWorkspace } from "../../../client/src/catalog.ts"
import FolderPickerDialog from "../components/common/FolderPickerDialog.vue"
import { i18n } from "../i18n/index.ts"
import { useFleetStore } from "../stores/fleet.ts"
import NewProjectView from "./NewProjectView.vue"

let pinia: Pinia
let wrapper: VueWrapper
const path = "/Users/test/同一个项目"
const project = (id: string): CatalogWorkspace => ({ id, name: "同一个项目", worktrees: [{ id: "wt-" + id, workspaceId: id, directories: [{ path }] }] })

async function open(query: { fromProject?: string; machine?: string } = {}, client?: DeskfleetDesktopApi) {
  pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: {} }, { path: "/projects/new", name: "new-project", component: {} },
    { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
  ] })
  await router.push({ name: "new-project", query })
  wrapper = mount(NewProjectView, { global: { plugins: [pinia, router, i18n], provide: client ? { [platformClientKey as symbol]: client } : {}, stubs: { FolderPickerDialog: true, PaneHeader: true } } })
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  fleet.catalogReady = true
  fleet.catalog = { teamId: "t", machineId: "m", machineName: "Mac", workspaces: [project("first")], sessions: [], sessionIds: [] }
  return { fleet, router, picker: wrapper.getComponent(FolderPickerDialog) }
}

afterEach(() => { wrapper?.unmount(); if (pinia) disposePinia(pinia) })

test("choosing an already bound folder creates a new independent project with the folder name", async () => {
  const { fleet, router, picker } = await open()
  const reply = Promise.withResolvers<CatalogWorkspace>()
  const create = vi.spyOn(fleet, "createWorkspace").mockReturnValue(reply.promise)
  picker.vm.$emit("select", path)
  picker.vm.$emit("select", path)
  expect(create).toHaveBeenCalledExactlyOnceWith("同一个项目", [{ path }])
  reply.resolve(project("second"))
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/workspaces/second/agent?machine=local-daemon")
})

test.each([["first", "/workspaces/first/agent?machine=local-daemon"], ["unknown", "/?machine=local-daemon"]])("cancel skips creation and returns to a valid origin (%s)", async (origin, expected) => {
  const { fleet, router, picker } = await open({ fromProject: origin })
  const create = vi.spyOn(fleet, "createWorkspace")
  picker.vm.$emit("cancel")
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  expect(router.currentRoute.value.fullPath).toBe(expected)
})

test("a creation that finishes after leaving does not reopen a project", async () => {
  const { fleet, router, picker } = await open()
  const reply = Promise.withResolvers<CatalogWorkspace>()
  vi.spyOn(fleet, "createWorkspace").mockReturnValue(reply.promise)
  picker.vm.$emit("select", path)
  await router.push("/")
  reply.resolve(project("second"))
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/")
})

test.each(["darwin", "web"] as const)("the project-aware %s host browses and creates on the selected Windows registration", async platform => {
  const selected = String.raw`C:\src\Weather`
  const calls: unknown[][] = []
  async function rpc<T>(team: string, machine: string, method: string, params: unknown): Promise<T> {
    calls.push([team, machine, method, params])
    if (team !== "team-1" || machine !== "pc") throw Error("Wrong registration")
    if (method === "directoryList") return { path: selected, parentPath: null, homePath: selected, directories: [], roots: [] } as T
    if (method === "workspaceCreate") return project("windows") as T
    throw Error(method)
  }
  const remote = remoteMachineClient({ ...getClient(), platform, mobile: platform === "web", remoteWorkspaceAgent: platform === "web" }, { ...fakeCentral().central, rpc }, machineFixture("pc", "team-1", "PC"))
  try {
    const { picker, router } = await open({ machine: "pc" }, remote.api)
    expect((await picker.props("browse")()).path).toBe(selected)
    picker.vm.$emit("select", selected)
    await flushPromises()
    expect(calls).toEqual([
      ["team-1", "pc", "directoryList", {}],
      ["team-1", "pc", "workspaceCreate", { name: "Weather", directories: [{ path: selected }] }],
    ])
    expect(router.currentRoute.value.fullPath).toBe("/workspaces/windows/agent?machine=pc")
  } finally { remote.dispose() }
})
