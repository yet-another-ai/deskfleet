import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "./App.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { catalogFixture, sessionWorktreeId, mainWorktreeId, sessionId, workspaceId } from "./test/catalog.ts"
import type { LocalAgentState } from "../../client/src/local-agent.ts"

const mounted: { wrapper: VueWrapper; pinia: ReturnType<typeof createPinia> }[] = []
async function mountApp(path = "/", pinia = createPinia()) {
  await router.push(path)
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: { Teleport: { inheritAttrs: false, template: "<slot />" }, LiveTerminal: { props: ["terminalId"], template: '<div data-terminal :data-id="terminalId" />' } } },
  })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return wrapper
}
function link(wrapper: VueWrapper, text: string) { return wrapper.findAll("a").find(a => a.text() === text)! }
function button(wrapper: VueWrapper, text: string) { return wrapper.findAll("button").find(entry => entry.text() === text)! }
const chips = (wrapper: VueWrapper) => wrapper.findAll("[data-composer-context]").map(chip => chip.text())
function panel(wrapper: VueWrapper) { return wrapper.get('aside[aria-label="Changes"]') }

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
  vi.spyOn(platformClient.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "test-host", online: true, desktop: true })
  vi.spyOn(platformClient.filesystem, "listDirectories").mockImplementation(async (path = "/") => ({
    path, parentPath: path === "/" ? null : "/", homePath: "/", roots: [{ name: "/", path: "/" }],
    directories: path === "/" ? ["notes", "code", "replacement"].map(name => ({ name, path: `/${name}`, hidden: false })) : [],
  }))
})
afterEach(() => {
  for (const { wrapper, pinia } of mounted.splice(0)) { wrapper.unmount(); disposePinia(pinia) }
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("the app targets a workspace and lists its sessions without exposing an internal main worktree", async () => {
  const wrapper = await mountApp()
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "storefront", "New worktree", "Codex"])
  expect(wrapper.get<HTMLButtonElement>('[aria-label="Send"]').element.disabled).toBe(true)
  expect(wrapper.get("aside").text()).not.toContain("Example team")
  expect(link(wrapper, "storefront").attributes("href")).toBe(`#/workspaces/${workspaceId}`)
  expect(link(wrapper, `Session ${sessionId}`).attributes("href")).toBe(`#/sessions/${sessionId}`)
  expect(wrapper.find('a[href*="/worktrees/"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain("Main worktree")
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
})

test("workspace creation opens a dialog, requires paths, supports choosing the first path by reordering, and retains input after failure", async () => {
  const create = vi.spyOn(platformClient.catalog, "createWorkspace").mockRejectedValueOnce(new Error("Directory does not exist"))
  const wrapper = await mountApp()
  await wrapper.get('[aria-label="Add workspace"]').trigger("click")
  expect(wrapper.get('[role=dialog]').attributes("data-state")).toBe("open")
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await wrapper.get("[role=dialog] form").trigger("submit")
  expect(create).not.toHaveBeenCalled()
  expect(wrapper.get('[role=dialog] [role="alert"]').text()).toBe("Choose at least one directory.")
  expect(wrapper.find('input[name^="directory-name"]').exists()).toBe(false)
  expect(wrapper.find('input[name^="directory-path"]').exists()).toBe(false)
  await wrapper.get('button[name="directory-path-0"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/notes"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await button(wrapper, "Add directory").trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/code"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  expect(wrapper.get('button[name="directory-path-0"]').text()).toContain("/code")
  await wrapper.get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(wrapper.get('[role=dialog] [role="alert"]').text()).toBe("Directory does not exist")
  expect((wrapper.get('input[name="workspace-name"]').element as HTMLInputElement).value).toBe("notes")
  const paths = [{ path: "/code" }, { path: "/notes" }]
  expect(create).toHaveBeenCalledWith("notes", paths)
  create.mockResolvedValueOnce({ id: "9007199254741003", name: "notes", worktrees: [{ id: "9007199254741005", workspaceId: "9007199254741003", directories: paths }] })
  await wrapper.get("[role=dialog] form").trigger("submit")
  await vi.waitFor(() => expect(router.currentRoute.value.params.workspaceId).toBe("9007199254741003"))
  expect(wrapper.find("[role=dialog]").exists()).toBe(false)
  expect(wrapper.get("main").text()).toContain("No sessions yet.")
  expect(wrapper.get("main").text()).not.toContain("Main worktree")
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
  expect(wrapper.get("main").text()).toContain("/code")
  await link(wrapper, "New session").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "notes", "New worktree", "Codex"])
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
})

test("cancelling workspace creation closes its dialog without creating", async () => {
  const create = vi.spyOn(platformClient.catalog, "createWorkspace")
  const wrapper = await mountApp()
  await wrapper.get('[aria-label="Add workspace"]').trigger("click")
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await button(wrapper, "Cancel").trigger("click")
  await vi.waitFor(() => expect(wrapper.find("[role=dialog]").exists()).toBe(false))
  expect(create).not.toHaveBeenCalled()
})

test("workspace edits update its configured directories without independent worktree maintenance", async () => {
  const value = catalogFixture().workspaces[0]!
  value.name = "renamed"
  value.worktrees[0]!.directories = [{ path: "/replacement" }, { path: "/code/web" }]
  const update = vi.spyOn(platformClient.catalog, "updateWorkspace").mockResolvedValue(value)
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  expect(button(wrapper, "Add worktree")).toBeUndefined()
  await button(wrapper, "Edit workspace").trigger("click")
  await wrapper.get('input[name="workspace-name"]').setValue("renamed")
  await wrapper.get('button[name="directory-path-1"]').trigger("click")
  await flushPromises()
  expect(platformClient.filesystem.listDirectories).toHaveBeenLastCalledWith("/code/api")
  await wrapper.get('[role=dialog] [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/replacement"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  await wrapper.get("main form").trigger("submit")
  await flushPromises()
  expect(update).toHaveBeenCalledWith(workspaceId, "renamed", [{ path: "/replacement" }, { path: "/code/web" }])
  expect(wrapper.get("main header").text()).toBe("renamed test-host")
  expect(wrapper.get("main").text()).toContain("/replacement")
  expect(button(wrapper, "Edit worktree")).toBeUndefined()
  expect(button(wrapper, "Delete worktree")).toBeUndefined()
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
})

test("workspace New session chooses that workspace before opening the composer", async () => {
  const snapshot = catalogFixture()
  snapshot.workspaces.push({ id: "2", name: "notes", worktrees: [{ id: "3", workspaceId: "2", directories: [{ path: "/notes" }] }] })
  vi.mocked(platformClient.catalog.list).mockResolvedValue(snapshot)
  const wrapper = await mountApp("/workspaces/2")
  expect(wrapper.get("main").text()).toContain("No sessions yet.")
  await button(wrapper, "New session").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "notes", "New worktree", "Codex"])
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
})

test("workspace deletion requires confirmation and clears its composer target", async () => {
  const remove = vi.spyOn(platformClient.catalog, "deleteWorkspace").mockResolvedValue()
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  await button(wrapper, "Delete workspace").trigger("click")
  expect(remove).not.toHaveBeenCalled()
  expect(wrapper.get("main").text()).toContain("Its directories remain on disk")
  await button(wrapper, "Confirm deletion").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(remove).toHaveBeenCalledWith(workspaceId)
  expect(chips(wrapper)).toEqual([])
})

test.each([
  ["Open terminal in default directory", "/code/web"],
  ["Open terminal in /code/api", "/code/api"],
])("%s sends the correct cwd and retains machine ownership", async (label, cwd) => {
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ id: options.terminalId, title: "shell", cwd, cols: 80, rows: 24, status: "running" }))
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  const target = wrapper.findAll("button").find(entry => entry.text() === label || entry.attributes("aria-label") === label)!
  await target.trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("machine-control"))
  expect(dial).toHaveBeenCalledWith({ mode: "create", terminalId: expect.any(String), cols: 80, rows: 24, cwd })
  expect(router.currentRoute.value.query).toEqual({ tab: "terminal", terminal: dial.mock.calls[0]![0].terminalId })
  expect(wrapper.get('[role="tablist"][aria-label="Remote control"] [aria-selected="true"]').text()).toBe("Terminal")
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
})

test("refresh failure preserves directories and disables workspace mutations until retry", async () => {
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  vi.mocked(platformClient.catalog.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
  await button(wrapper, "Refresh").trigger("click")
  await flushPromises()
  expect(wrapper.get('aside [role="alert"]').text()).toBe("Daemon disconnected")
  expect(wrapper.get("main").text()).toContain("/code/web")
  expect(button(wrapper, "Edit workspace").attributes("disabled")).toBeDefined()
  await button(wrapper, "Refresh").trigger("click")
  await flushPromises()
  expect(button(wrapper, "Edit workspace").attributes("disabled")).toBeUndefined()
})

test("a session links to its own read-only worktree", async () => {
  const pinia = createPinia()
  vi.spyOn(useAgentSessionsStore(pinia), "watchGit").mockResolvedValue(() => {})
  const status = vi.spyOn(useAgentSessionsStore(pinia), "gitStatus").mockResolvedValue({
    sessionId, directories: [{ path: "/worktrees/api/session", repositoryId: "checkout" }],
    repositories: [{ id: "checkout", root: "/worktrees/api/session", branch: "session-branch", head: "abc123", changes: [] }],
  })
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia)
  expect(status).toHaveBeenCalledWith(sessionId, false)
  expect(panel(wrapper).text()).toContain("session-branch")
  expect(wrapper.get("main header").text()).toContain(`Session ${sessionId}`)
  const worktreeLink = wrapper.get(`main a[href="#/worktrees/${sessionWorktreeId}"]`)
  expect(worktreeLink.text()).toContain("Worktree")
  await worktreeLink.trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("worktree"))
  expect(wrapper.get("main header").text()).toContain("Worktree")
  expect(wrapper.get("main").text()).toContain("/worktrees/api/session")
  expect(button(wrapper, "New session")).toBeUndefined()
  expect(button(wrapper, "Edit worktree")).toBeUndefined()
  expect(button(wrapper, "Delete worktree")).toBeUndefined()
  await flushPromises()
  expect(panel(wrapper).text()).toContain("session-branch")
  expect(panel(wrapper).text()).toContain("/worktrees/api/session")
})

test("the internal main worktree has no directly accessible page", async () => {
  const wrapper = await mountApp(`/worktrees/${mainWorktreeId}`)
  expect(wrapper.get("main").text()).toContain("This worktree does not exist.")
  expect(wrapper.get("main").text()).not.toContain("/code/web")
  expect(wrapper.find(`a[href="#/worktrees/${mainWorktreeId}"]`).exists()).toBe(false)
})

test("the localized composer and local footer do not expose an internal main worktree", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const wrapper = await mountApp()
  expect(chips(wrapper)).toHaveLength(4)
  expect(chips(wrapper)).toContain("新建工作树")
  expect(chips(wrapper)).toContain("storefront")
  expect(wrapper.text()).not.toContain("主工作树")
  expect(wrapper.get("footer").text()).toBe("本本地")
})

test("settings replaces the app layout, returns to the previous page, and refreshes resources after lifecycle transitions", async () => {
  const listeners = new Set<(state: LocalAgentState) => void>()
  vi.spyOn(platformClient.settings, "onChanged").mockImplementation(listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  vi.spyOn(platformClient.settings, "get").mockResolvedValue({ enabled: true, status: "running" })
  const list = vi.spyOn(platformClient.terminal, "list").mockResolvedValue([])
  const view = await mountApp(`/workspaces/${workspaceId}`)
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  expect(view.find("aside").exists()).toBe(false)
  expect(view.get('main nav [aria-current="page"]').text()).toBe("Preferences")
  expect(view.get("main h1").text()).toBe("Preferences")
  expect(view.get('main [role="switch"][aria-labelledby="launch-at-startup-label"]').attributes("disabled")).toBeDefined()
  expect(view.get("#launch-at-startup-label").text()).toBe("Launch at startup")
  expect(view.get("#keep-awake-label").text()).toBe("Keep Awake")
  expect(view.get('main [role="switch"][aria-labelledby="keep-awake-label"]').attributes("aria-checked")).toBe("false")
  expect(view.get('main section[aria-labelledby="this-computer-heading"]').text()).toContain("Run local Agent")
  vi.mocked(platformClient.catalog.list).mockClear()
  list.mockClear()
  for (const listener of listeners) listener({ enabled: false, status: "stopping" })
  await flushPromises()
  expect(platformClient.catalog.list).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  for (const [index, status] of (["stopped", "running", "error"] as const).entries()) {
    for (const listener of listeners) listener({ enabled: status === "running", status })
    await flushPromises()
    expect(platformClient.catalog.list).toHaveBeenCalledTimes(index + 1)
    expect(list).toHaveBeenCalledTimes(index + 1)
  }
  await button(view, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("workspace"))
  await flushPromises()
  expect(listeners.size).toBe(1)
  expect(view.get("main").text()).toContain("/code/web")
  view.unmount()
  expect(listeners.size).toBe(0)
})

test("notifications have a dedicated settings section and retain the return destination", async () => {
  const view = await mountApp(`/workspaces/${workspaceId}`)
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  await view.get('main nav a[href="#/settings/notifications"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-notifications"))
  await flushPromises()
  expect(view.get('main nav [aria-current="page"]').text()).toBe("Notifications")
  expect(view.get("main h1").text()).toBe("Notifications")
  expect(view.findAll('main [role="switch"]')).toHaveLength(3)
  await button(view, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("workspace"))
})

test("returning focus to the window refreshes the local machine", async () => {
  const list = vi.mocked(platformClient.catalog.list)
  await mountApp()
  const afterMount = list.mock.calls.length
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(list.mock.calls.length).toBeGreaterThan(afterMount)
})

test("sidebar and Changes panel controls retain their layout behavior and ignore the removed Details tab", async () => {
  window.localStorage.setItem("deskfleet.details-tab", "details")
  const wrapper = await mountApp()
  expect(panel(wrapper).find('[role="tablist"]').exists()).toBe(false)
  expect(wrapper.find('aside[aria-label="Details"]').exists()).toBe(false)
  expect(wrapper.find('[id="details-tab-details"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Hide sidebar"]').trigger("click")
  expect(wrapper.get("main header").find('[aria-label="Show sidebar"]').exists()).toBe(true)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("false")
  await wrapper.get('[aria-label="Hide changes panel"]').trigger("click")
  expect(wrapper.find('aside[aria-label="Changes"]').exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.details-open")).toBe("false")
  await wrapper.get('[aria-label="Show changes panel"]').trigger("click")
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
  expect(window.localStorage.getItem("deskfleet.details-open")).toBe("true")
})

test("repeated navigation and browser history retain Changes without reviving Details", async () => {
  const pinia = createPinia()
  vi.spyOn(useAgentSessionsStore(pinia), "watchGit").mockResolvedValue(() => {})
  const status = vi.spyOn(useAgentSessionsStore(pinia), "gitStatus").mockResolvedValue({
    sessionId, directories: [{ path: "/worktrees/api/session", repositoryId: "checkout" }],
    repositories: [{ id: "checkout", root: "/worktrees/api/session", branch: "session-branch", head: "abc123", changes: [] }],
  })
  const wrapper = await mountApp(`/workspaces/${workspaceId}`, pinia)
  for (let index = 0; index < 3; index++) {
    await link(wrapper, `Session ${sessionId}`).trigger("click")
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("session"))
    await flushPromises()
    expect(panel(wrapper).text()).toContain("session-branch")
    await wrapper.get('[aria-label="Back"]').trigger("click")
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("workspace"))
    await flushPromises()
    expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
    await wrapper.get('[aria-label="Forward"]').trigger("click")
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("session"))
    await flushPromises()
    expect(panel(wrapper).text()).toContain("session-branch")
    await link(wrapper, "storefront").trigger("click")
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("workspace"))
  }
  expect(status).toHaveBeenCalledWith(sessionId, false)
  expect(wrapper.find('aside[aria-label="Details"]').exists()).toBe(false)
  expect(panel(wrapper).find('[role="tab"]').exists()).toBe(false)
})

test("an unrecognized Details URL falls back to the composer and Settings returns there", async () => {
  const wrapper = await mountApp("/details")
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(wrapper.find('a[href="#/details"]').exists()).toBe(false)
  expect(panel(wrapper).find('[role="tab"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  expect(wrapper.find('aside[aria-label="Changes"]').exists()).toBe(false)
  await button(wrapper, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  await flushPromises()
  expect(panel(wrapper).text()).toContain("Git changes are available within a session.")
})
