import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { WorktreeRootState } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import WorktreeRootSettings from "./WorktreeRootSettings.vue"

let wrapper: VueWrapper | undefined
const defaults: WorktreeRootState = { root: null, defaultRoot: "/home/user/.deskfleet/worktrees" }
const custom: WorktreeRootState = { root: "/mnt/data/worktrees", defaultRoot: defaults.defaultRoot }

function render() {
  wrapper = mount(WorktreeRootSettings, { global: { plugins: [i18n] } })
  return wrapper
}

function button(view: VueWrapper, text: string) {
  const found = view.findAll("button").find(candidate => candidate.text() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

beforeEach(() => {
  vi.spyOn(platformClient.settings, "getWorktreeRoot").mockResolvedValue(defaults)
  vi.spyOn(platformClient.settings, "chooseWorktreeRoot").mockResolvedValue(custom.root)
  vi.spyOn(platformClient.settings, "setWorktreeRoot").mockResolvedValue(custom)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("waits for loading, folder selection, and saving before displaying the confirmed path", async () => {
  let loaded!: (state: WorktreeRootState) => void
  vi.mocked(platformClient.settings.getWorktreeRoot).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  let chosen!: (root: string | null) => void
  vi.mocked(platformClient.settings.chooseWorktreeRoot).mockReturnValueOnce(new Promise(resolve => { chosen = resolve }))
  let saved!: (state: WorktreeRootState) => void
  vi.mocked(platformClient.settings.setWorktreeRoot).mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  const choose = button(view, "Choose folder…")
  expect(choose.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Loading settings…")
  loaded(defaults)
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(defaults.defaultRoot)
  expect(choose.attributes("disabled")).toBeUndefined()
  await choose.trigger("click")
  expect(platformClient.settings.chooseWorktreeRoot).toHaveBeenCalledExactlyOnceWith()
  expect(choose.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Choosing folder…")
  expect(platformClient.settings.setWorktreeRoot).not.toHaveBeenCalled()
  chosen(custom.root)
  await flushPromises()
  expect(platformClient.settings.setWorktreeRoot).toHaveBeenCalledExactlyOnceWith(custom.root)
  expect(choose.attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Saving…")
  expect(view.get("#worktree-root-path").text()).toBe(defaults.defaultRoot)
  saved(custom)
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(custom.root)
  expect(choose.attributes("disabled")).toBeUndefined()
  expect(button(view, "Use default").exists()).toBe(true)
})

test("resets a custom directory to the default", async () => {
  vi.mocked(platformClient.settings.getWorktreeRoot).mockResolvedValue(custom)
  let saved!: (state: WorktreeRootState) => void
  vi.mocked(platformClient.settings.setWorktreeRoot).mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  const view = render()
  await flushPromises()
  const reset = button(view, "Use default")
  await reset.trigger("click")
  expect(platformClient.settings.setWorktreeRoot).toHaveBeenCalledExactlyOnceWith(null)
  expect(reset.attributes("disabled")).toBeDefined()
  expect(button(view, "Choose folder…").attributes("disabled")).toBeDefined()
  expect(view.get("#worktree-root-path").text()).toBe(custom.root)
  saved(defaults)
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(defaults.defaultRoot)
  expect(view.findAll("button").map(candidate => candidate.text())).toEqual(["Choose folder…"])
})

test("keeps the saved directory when the folder dialog is cancelled", async () => {
  vi.mocked(platformClient.settings.getWorktreeRoot).mockResolvedValue(custom)
  vi.mocked(platformClient.settings.chooseWorktreeRoot).mockResolvedValue(null)
  const view = render()
  await flushPromises()
  await button(view, "Choose folder…").trigger("click")
  await flushPromises()
  expect(platformClient.settings.setWorktreeRoot).not.toHaveBeenCalled()
  expect(view.get("#worktree-root-path").text()).toBe(custom.root)
  expect(button(view, "Choose folder…").attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("retains the saved directory after a failed save and allows choosing again", async () => {
  vi.mocked(platformClient.settings.setWorktreeRoot).mockRejectedValueOnce(new Error("Directory is not writable"))
  const view = render()
  await flushPromises()
  const choose = button(view, "Choose folder…")
  await choose.trigger("click")
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(defaults.defaultRoot)
  expect(view.get('[role="alert"]').text()).toBe("Directory is not writable")
  expect(choose.attributes("disabled")).toBeUndefined()
  await choose.trigger("click")
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(custom.root)
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("shows folder dialog errors and allows another selection", async () => {
  vi.mocked(platformClient.settings.chooseWorktreeRoot).mockRejectedValueOnce(new Error("Folder dialog unavailable"))
  const view = render()
  await flushPromises()
  const choose = button(view, "Choose folder…")
  await choose.trigger("click")
  await flushPromises()
  expect(platformClient.settings.setWorktreeRoot).not.toHaveBeenCalled()
  expect(view.get('[role="alert"]').text()).toBe("Folder dialog unavailable")
  expect(choose.attributes("disabled")).toBeUndefined()
  await choose.trigger("click")
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(custom.root)
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("offers a reload when the initial read fails", async () => {
  vi.mocked(platformClient.settings.getWorktreeRoot).mockRejectedValueOnce(new Error("Settings unavailable"))
  const view = render()
  await flushPromises()
  expect(button(view, "Choose folder…").attributes("disabled")).toBeDefined()
  expect(view.get('[role="alert"]').text()).toBe("Settings unavailable")
  await button(view, "Reload settings").trigger("click")
  await flushPromises()
  expect(view.get("#worktree-root-path").text()).toBe(defaults.defaultRoot)
  expect(button(view, "Choose folder…").attributes("disabled")).toBeUndefined()
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test.each([
  ["en-US", "Worktree root directory", "Store worktrees for new Sessions on this computer here. Existing files stay in place.", "Choose folder…", "Use default"],
  ["zh-cmn-Hans-CN", "工作树根目录", "本机新建会话的工作树将存储在此目录。已有文件保留在原位置。", "选择文件夹…", "使用默认目录"],
] as const)("explains the directory setting and its scope in %s", async (locale, label, description, chooseLabel, resetLabel) => {
  i18n.global.locale.value = locale
  vi.mocked(platformClient.settings.getWorktreeRoot).mockResolvedValue(custom)
  const view = render()
  await flushPromises()
  expect(view.get("#worktree-root-label").text()).toBe(label)
  expect(view.get("#worktree-root-description").text()).toContain(description)
  expect(button(view, chooseLabel).attributes("aria-describedby")).toBe("worktree-root-label worktree-root-description")
  expect(button(view, resetLabel).exists()).toBe(true)
})
