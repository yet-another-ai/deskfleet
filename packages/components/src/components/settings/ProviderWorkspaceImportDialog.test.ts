import { client } from "@deskfleet/client/platform"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import ProviderWorkspaceImportDialog from "./ProviderWorkspaceImportDialog.vue"

let wrapper: VueWrapper | undefined
let catalog: CatalogSnapshot
const candidates = [
  { name: "Existing", path: "/code/existing", source: "config.toml" },
  { name: "First", path: "/code/first", source: "config.toml" },
  { name: "Second", path: "/code/second", source: "config.toml" },
]
const button = (view: VueWrapper, text: string) => view.findAll("button").find(value => value.text() === text)!
const row = (view: VueWrapper, path: string) => view.get(`[data-workspace-import-path="${path}"]`)
async function render() {
  wrapper = mount(ProviderWorkspaceImportDialog, {
    props: { provider: { id: "work-codex", name: "Work Codex", template: "codex", env: {} }, machineName: "Build machine" },
    attachTo: document.body,
    global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  catalog = { teamId: "team", machineId: "machine", machineName: "Build machine", sessionIds: [], sessions: [], workspaces: [
    { id: "1", name: "Existing workspace", worktrees: [
      { id: "1", workspaceId: "1", directories: [{ path: "/code/existing" }] },
      { id: "2", workspaceId: "1", sessionId: "session", directories: [{ path: "/code/first" }] },
    ] },
  ] }
  vi.spyOn(client.providers, "discoverWorkspaces").mockResolvedValue({ supported: true, candidates, warnings: [] })
  // The central replica has not synchronized any directories yet.
  vi.spyOn(client.catalog, "list").mockImplementation(async options => ({ ...structuredClone(catalog), ...(!options?.live && { workspaces: [] }) }))
  vi.spyOn(client.catalog, "createWorkspace").mockImplementation(async (name, directories) => {
    const workspace = { id: String(catalog.workspaces.length + 1), name, worktrees: [{ id: "main", directories }] }
    catalog.workspaces.push(workspace)
    return workspace
  })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

test("offers unselected directories, marks existing workspace directories, and allows skipping", async () => {
  const view = await render()
  expect(client.providers.discoverWorkspaces).toHaveBeenCalledExactlyOnceWith("work-codex")
  expect(client.catalog.list).toHaveBeenCalledExactlyOnceWith({ live: true })
  expect(view.text()).toContain("Work Codex on Build machine")
  expect(view.findAll('[role="checkbox"]').every(value => value.attributes("aria-checked") === "false")).toBe(true)
  expect(row(view, "/code/existing").text()).toContain("Already in Workspaces")
  expect(row(view, "/code/existing").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  // A Session's captured directory does not mean there is a Workspace for that directory.
  expect(row(view, "/code/first").get('[role="checkbox"]').attributes("disabled")).toBeUndefined()
  expect(view.get("[data-import-selected]").attributes("disabled")).toBeDefined()
  await button(view, "Skip for now").trigger("click")
  await vi.waitFor(() => expect(view.emitted("close")).toHaveLength(1))
  expect(client.catalog.createWorkspace).not.toHaveBeenCalled()
})

test("imports only selected directories and retains successes when a later import fails", async () => {
  const create = vi.mocked(client.catalog.createWorkspace)
  create.mockRejectedValueOnce(new Error("Directory disappeared"))
  const view = await render()
  await row(view, "/code/first").get('[role="checkbox"]').trigger("click")
  await row(view, "/code/second").get('[role="checkbox"]').trigger("click")
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(2)
  expect(create).not.toHaveBeenCalledWith("Existing", expect.anything())
  expect(row(view, "/code/first").get('[role="alert"]').text()).toBe("Directory disappeared")
  expect(row(view, "/code/second").text()).toContain("Imported")
  expect(row(view, "/code/second").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(3)
  expect(create).toHaveBeenLastCalledWith("First", [{ path: "/code/first" }])
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.text()).toContain("2 Workspaces imported")
  await button(view, "Done").trigger("click")
  await vi.waitFor(() => expect(view.emitted("close")).toHaveLength(1))
})

test("rechecks the catalog before importing and skips a directory added while reviewing", async () => {
  const view = await render()
  await row(view, "/code/first").get('[role="checkbox"]').trigger("click")
  catalog.workspaces.push({ id: "3", name: "Added elsewhere", worktrees: [{ id: "3", directories: [{ path: "/code/first" }] }] })
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(client.catalog.createWorkspace).not.toHaveBeenCalled()
  expect(row(view, "/code/first").text()).toContain("Already in Workspaces")
})

test("retry reads the live catalog when a creation committed but its response was lost", async () => {
  const create = vi.mocked(client.catalog.createWorkspace).mockImplementationOnce(async (name, directories) => {
    catalog.workspaces.push({ id: "3", name, worktrees: [{ id: "3", directories }] })
    throw new Error("Response lost")
  })
  const view = await render()
  await row(view, "/code/first").get('[role="checkbox"]').trigger("click")
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(row(view, "/code/first").get('[role="alert"]').text()).toBe("Response lost")
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
  expect(row(view, "/code/first").text()).toContain("Already in Workspaces")
  expect(row(view, "/code/first").find('[role="alert"]').exists()).toBe(false)
})

test("matches existing directory paths across trailing separators and Windows spelling", async () => {
  catalog.workspaces[0]!.worktrees[0]!.directories = [{ path: "/code/first/" }, { path: "C:\\Code\\Project\\" }]
  vi.mocked(client.providers.discoverWorkspaces).mockResolvedValue({ supported: true, candidates: [
    { name: "First", path: "/code/first", source: "config.toml" },
    { name: "Windows project", path: "c:/code/project", source: "config.toml" },
  ], warnings: [] })
  const view = await render()
  expect(view.findAll('[role="checkbox"]').every(checkbox => checkbox.attributes("disabled") !== undefined)).toBe(true)
  expect(view.findAll("[data-workspace-import-path]").every(row => row.text().includes("Already in Workspaces"))).toBe(true)
})

test("discovery failures can be retried without creating workspaces", async () => {
  vi.mocked(client.providers.discoverWorkspaces).mockRejectedValueOnce(new Error("Machine disconnected"))
  const view = await render()
  expect(view.get('[role="alert"]').text()).toBe("Machine disconnected")
  await button(view, "Retry").trigger("click")
  await flushPromises()
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.findAll("[data-workspace-import-path]")).toHaveLength(3)
  expect(client.catalog.createWorkspace).not.toHaveBeenCalled()
})

test("leaving the machine during a batch stops remaining imports", async () => {
  let finish!: () => void
  vi.mocked(client.catalog.createWorkspace).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "3", name: "First", worktrees: [] }) }))
  const view = await render()
  await row(view, "/code/first").get('[role="checkbox"]').trigger("click")
  await row(view, "/code/second").get('[role="checkbox"]').trigger("click")
  await view.get("[data-import-selected]").trigger("click")
  await flushPromises()
  expect(client.catalog.createWorkspace).toHaveBeenCalledTimes(1)
  view.unmount()
  wrapper = undefined
  finish()
  await flushPromises()
  expect(client.catalog.createWorkspace).toHaveBeenCalledTimes(1)
})
