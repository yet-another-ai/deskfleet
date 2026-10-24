import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "./App.vue"
import { i18n } from "./i18n"
import { router } from "./router"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { catalogFixture, sessionWorktreeId, mainWorktreeId, sessionId, workspaceId } from "./test/catalog.ts"
import type { LocalAgentState } from "../../shared/local-agent.ts"

const mounted: { wrapper: VueWrapper; pinia: ReturnType<typeof createPinia> }[] = []
async function mountApp(path = "/") {
  await router.push(path)
  const pinia = createPinia()
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: { Teleport: true, LiveTerminal: { props: ["terminalId"], template: '<div data-terminal :data-id="terminalId" />' } } },
  })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return wrapper
}
function link(wrapper: VueWrapper, text: string) { return wrapper.findAll("a").find(a => a.text() === text)! }
function button(wrapper: VueWrapper, text: string) { return wrapper.findAll("button").find(entry => entry.text() === text)! }
const chips = (wrapper: VueWrapper) => wrapper.findAll("[data-composer-context]").map(chip => chip.text())
function panel(wrapper: VueWrapper) { return wrapper.get('aside[aria-label="Details"]') }

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(window.deskfleet.catalog, "list").mockResolvedValue(catalogFixture())
  vi.spyOn(window.deskfleet.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "test-host", online: true, desktop: true })
  vi.spyOn(window.deskfleet.filesystem, "listDirectories").mockImplementation(async (path = "/") => ({
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
  expect(panel(wrapper).text()).toContain("/code/web")
  expect(panel(wrapper).text()).toContain("/code/api")
})

test("workspace creation opens a dialog, requires paths, supports choosing the first path by reordering, and retains input after failure", async () => {
  const create = vi.spyOn(window.deskfleet.catalog, "createWorkspace").mockRejectedValueOnce(new Error("Directory does not exist"))
  const wrapper = await mountApp()
  await wrapper.get('[title="Add workspace"]').trigger("click")
  expect(wrapper.get<HTMLDialogElement>('dialog[aria-labelledby="workspace-create-title"]').element.open).toBe(true)
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await wrapper.get("dialog form").trigger("submit")
  expect(create).not.toHaveBeenCalled()
  expect(wrapper.get('dialog [role="alert"]').text()).toBe("Choose at least one directory.")
  expect(wrapper.find('input[name^="directory-name"]').exists()).toBe(false)
  expect(wrapper.find('input[name^="directory-path"]').exists()).toBe(false)
  await wrapper.get('button[name="directory-path-0"]').trigger("click")
  await flushPromises()
  await wrapper.get('dialog [data-path="/notes"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await button(wrapper, "Add directory").trigger("click")
  await flushPromises()
  await wrapper.get('dialog [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('dialog [data-path="/code"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  expect(wrapper.get('button[name="directory-path-0"]').text()).toContain("/code")
  await wrapper.get("dialog form").trigger("submit")
  await flushPromises()
  expect(wrapper.get('dialog [role="alert"]').text()).toBe("Directory does not exist")
  expect((wrapper.get('input[name="workspace-name"]').element as HTMLInputElement).value).toBe("notes")
  const paths = [{ path: "/code" }, { path: "/notes" }]
  expect(create).toHaveBeenCalledWith("notes", paths)
  create.mockResolvedValueOnce({ id: "9007199254741003", name: "notes", worktrees: [{ id: "9007199254741005", workspaceId: "9007199254741003", directories: paths }] })
  await wrapper.get("dialog form").trigger("submit")
  await vi.waitFor(() => expect(router.currentRoute.value.params.workspaceId).toBe("9007199254741003"))
  expect(wrapper.find("dialog").exists()).toBe(false)
  expect(wrapper.get("main").text()).toContain("No sessions yet.")
  expect(wrapper.get("main").text()).not.toContain("Main worktree")
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
  expect(wrapper.get("main").text()).toContain("/code")
  await link(wrapper, "New session").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "notes", "New worktree", "Codex"])
  expect(panel(wrapper).text()).toContain("/code")
  expect(panel(wrapper).text()).toContain("/notes")
})

test("cancelling workspace creation closes its dialog without creating", async () => {
  const create = vi.spyOn(window.deskfleet.catalog, "createWorkspace")
  const wrapper = await mountApp()
  await wrapper.get('[title="Add workspace"]').trigger("click")
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await button(wrapper, "Cancel").trigger("click")
  await vi.waitFor(() => expect(wrapper.find("dialog").exists()).toBe(false))
  expect(create).not.toHaveBeenCalled()
})

test("workspace edits update its configured directories without independent worktree maintenance", async () => {
  const value = catalogFixture().workspaces[0]!
  value.name = "renamed"
  value.worktrees[0]!.directories = [{ path: "/replacement" }, { path: "/code/web" }]
  const update = vi.spyOn(window.deskfleet.catalog, "updateWorkspace").mockResolvedValue(value)
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  expect(button(wrapper, "Add worktree")).toBeUndefined()
  await button(wrapper, "Edit workspace").trigger("click")
  await wrapper.get('input[name="workspace-name"]').setValue("renamed")
  await wrapper.get('button[name="directory-path-1"]').trigger("click")
  await flushPromises()
  expect(window.deskfleet.filesystem.listDirectories).toHaveBeenLastCalledWith("/code/api")
  await wrapper.get('dialog [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('dialog [data-path="/replacement"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  await wrapper.get("main form").trigger("submit")
  await flushPromises()
  expect(update).toHaveBeenCalledWith(workspaceId, "renamed", [{ path: "/replacement" }, { path: "/code/web" }])
  expect(wrapper.get("main header").text()).toBe("renamed test-host")
  expect(wrapper.get("main").text()).toContain("/replacement")
  expect(panel(wrapper).text()).toContain("/replacement")
  expect(button(wrapper, "Edit worktree")).toBeUndefined()
  expect(button(wrapper, "Delete worktree")).toBeUndefined()
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
})

test("workspace New session chooses that workspace before opening the composer", async () => {
  const snapshot = catalogFixture()
  snapshot.workspaces.push({ id: "2", name: "notes", worktrees: [{ id: "3", workspaceId: "2", directories: [{ path: "/notes" }] }] })
  vi.mocked(window.deskfleet.catalog.list).mockResolvedValue(snapshot)
  const wrapper = await mountApp("/workspaces/2")
  expect(wrapper.get("main").text()).toContain("No sessions yet.")
  await button(wrapper, "New session").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "notes", "New worktree", "Codex"])
  expect(panel(wrapper).text()).toContain("/notes")
  expect(panel(wrapper).text()).not.toContain("/code/web")
})

test("workspace deletion requires confirmation and clears its composer target", async () => {
  const remove = vi.spyOn(window.deskfleet.catalog, "deleteWorkspace").mockResolvedValue()
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
  const dial = vi.spyOn(window.deskfleet.terminal, "dial").mockImplementation(async options => ({ id: options.terminalId, title: "shell", cwd, cols: 80, rows: 24, status: "running" }))
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  const target = wrapper.findAll("button").find(entry => entry.text() === label || entry.attributes("aria-label") === label)!
  await target.trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("terminal"))
  expect(dial).toHaveBeenCalledWith({ mode: "create", terminalId: expect.any(String), cols: 80, rows: 24, cwd })
  expect(panel(wrapper).text()).toContain("ScopeMachine")
})

test("refresh failure preserves directories and disables workspace mutations until retry", async () => {
  const wrapper = await mountApp(`/workspaces/${workspaceId}`)
  vi.mocked(window.deskfleet.catalog.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
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
  const wrapper = await mountApp(`/sessions/${sessionId}`)
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
  const status = vi.spyOn(useAgentSessionsStore(mounted.at(-1)!.pinia), "gitStatus").mockResolvedValue({
    sessionId, directories: [{ path: "/worktrees/api/session", repositoryId: "checkout" }],
    repositories: [{ id: "checkout", root: "/worktrees/api/session", branch: "session-branch", head: "abc123", changes: [] }],
  })
  await panel(wrapper).findAll('[role="tab"]').find(tab => tab.text() === "Changes")!.trigger("click")
  await flushPromises()
  expect(status).toHaveBeenCalledExactlyOnceWith(sessionId)
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
  vi.spyOn(window.deskfleet.settings, "onChanged").mockImplementation(listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  vi.spyOn(window.deskfleet.settings, "get").mockResolvedValue({ enabled: true, status: "running" })
  const list = vi.spyOn(window.deskfleet.terminal, "list").mockResolvedValue([])
  const view = await mountApp(`/workspaces/${workspaceId}`)
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  expect(view.find("aside").exists()).toBe(false)
  expect(view.get('main nav [aria-current="page"]').text()).toBe("Preferences")
  expect(view.get("main h1").text()).toBe("Preferences")
  expect(view.get('main [role="switch"][aria-labelledby="launch-at-startup-label"]').attributes("disabled")).toBeDefined()
  expect(view.get("#launch-at-startup-label").text()).toBe("Launch at startup")
  expect(view.get('main section[aria-labelledby="this-computer-heading"]').text()).toContain("Run local Agent")
  vi.mocked(window.deskfleet.catalog.list).mockClear()
  list.mockClear()
  for (const listener of listeners) listener({ enabled: false, status: "stopping" })
  await flushPromises()
  expect(window.deskfleet.catalog.list).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  for (const [index, status] of (["stopped", "running", "error"] as const).entries()) {
    for (const listener of listeners) listener({ enabled: status === "running", status })
    await flushPromises()
    expect(window.deskfleet.catalog.list).toHaveBeenCalledTimes(index + 1)
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

test("sidebar and details panel controls retain their layout behavior", async () => {
  const wrapper = await mountApp()
  const [details, changes] = panel(wrapper).findAll('[role="tab"]')
  await details!.trigger("keydown", { key: "ArrowRight" })
  expect(changes!.attributes("aria-selected")).toBe("true")
  await wrapper.get('[aria-label="Hide sidebar"]').trigger("click")
  expect(wrapper.get("main header").find('[aria-label="Show sidebar"]').exists()).toBe(true)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("false")
  await wrapper.get('[aria-label="Hide details panel"]').trigger("click")
  expect(wrapper.find('aside[aria-label="Details"]').exists()).toBe(false)
})
