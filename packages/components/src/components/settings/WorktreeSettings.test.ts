import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { WorktreePreferences } from "../../../../client/src/settings.ts"
import { i18n } from "../../i18n/index.ts"
import UiNumberField from "../common/UiNumberField.vue"
import UiSelect from "../common/UiSelect.vue"
import WorktreeSettings from "./WorktreeSettings.vue"

let wrapper: VueWrapper | undefined
function defaults(): WorktreePreferences {
  return { branchNaming: "semantic", cleanup: { archived: true, merged: true, inactive: true, inactiveDays: 5, settled: true, settledDays: 6, unchanged: true, keepLocalChanges: "uncommitted" } }
}
function render() {
  wrapper = mount(WorktreeSettings, { global: { plugins: [i18n] } })
  return wrapper
}
async function expand(view: VueWrapper) {
  await view.get('[aria-controls="worktree-settled-row worktree-unchanged-row worktree-protection-row"]').trigger("click")
}

beforeEach(() => {
  vi.spyOn(platformClient.settings, "getWorktreePreferences").mockResolvedValue(defaults())
  vi.spyOn(platformClient.settings, "setWorktreePreferences").mockImplementation(async preferences => structuredClone(preferences))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("loads saved preferences, groups advanced cleanup, and keeps root storage available", async () => {
  let loaded!: (preferences: WorktreePreferences) => void
  vi.mocked(platformClient.settings.getWorktreePreferences).mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  const view = render()
  expect(view.get('#worktree-archived-row [role="switch"]').attributes("disabled")).toBeDefined()
  loaded(defaults())
  await flushPromises()
  expect(view.get("h1").text()).toBe("Worktrees")
  expect(view.get('#worktree-archived-row [role="switch"]').attributes("aria-checked")).toBe("true")
  expect(view.find("#worktree-settled-row").exists()).toBe(false)
  await expand(view)
  expect(view.get("#worktree-settled-row").isVisible()).toBe(true)
  expect(view.get("#worktree-protection-description").text()).toContain("Deletes ignored files, including .env")
  expect(view.get("#worktree-root-label").text()).toBe("Worktree root directory")
})

test("waits for a confirmed plain-data save before changing switches", async () => {
  let saved!: (preferences: WorktreePreferences) => void
  vi.mocked(platformClient.settings.setWorktreePreferences).mockImplementationOnce(preferences => {
    structuredClone(preferences)
    return new Promise(resolve => { saved = resolve })
  })
  const view = render()
  await flushPromises()
  const toggle = view.get('#worktree-archived-row [role="switch"]')
  await toggle.trigger("click")
  const next = defaults()
  next.cleanup.archived = false
  expect(platformClient.settings.setWorktreePreferences).toHaveBeenCalledExactlyOnceWith(next)
  expect(toggle.attributes("disabled")).toBeDefined()
  expect(toggle.attributes("aria-checked")).toBe("true")
  saved(next)
  await flushPromises()
  expect(toggle.attributes("disabled")).toBeUndefined()
  expect(toggle.attributes("aria-checked")).toBe("false")
})

test("keeps the saved preference after failure and allows retry", async () => {
  vi.mocked(platformClient.settings.setWorktreePreferences).mockRejectedValueOnce(new Error("Could not save preferences"))
  const view = render()
  await flushPromises()
  const toggle = view.get('#worktree-merged-row [role="switch"]')
  await toggle.trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Could not save preferences")
  expect(toggle.attributes("aria-checked")).toBe("true")
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-checked")).toBe("false")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("saves zero-day settled cleanup and rejects invalid days without an IPC call", async () => {
  const view = render()
  await flushPromises()
  await expand(view)
  const fields = view.findAllComponents(UiNumberField)
  fields[1]!.vm.$emit("update:modelValue", 0)
  await flushPromises()
  expect(vi.mocked(platformClient.settings.setWorktreePreferences).mock.calls.at(-1)![0].cleanup.settledDays).toBe(0)
  vi.mocked(platformClient.settings.setWorktreePreferences).mockClear()
  for (const value of [Number.NaN, -1, 1.5, 3651]) fields[1]!.vm.$emit("update:modelValue", value)
  fields[0]!.vm.$emit("update:modelValue", 0)
  await flushPromises()
  expect(platformClient.settings.setWorktreePreferences).not.toHaveBeenCalled()
  await view.get('#worktree-inactive-row [role="switch"]').trigger("click")
  await flushPromises()
  expect(fields[0]!.props("disabled")).toBe(true)
})

test("saves branch naming and protection while preserving other preferences", async () => {
  const view = render()
  await flushPromises()
  await expand(view)
  const selects = view.findAllComponents(UiSelect)
  selects[0]!.vm.$emit("update:modelValue", "session")
  await flushPromises()
  expect(view.get("#worktree-branch-description").text()).toContain("Session identifier")
  selects[1]!.vm.$emit("update:modelValue", "all")
  await flushPromises()
  const expected = defaults()
  expected.branchNaming = "session"
  expected.cleanup.keepLocalChanges = "all"
  expect(vi.mocked(platformClient.settings.setWorktreePreferences).mock.calls.at(-1)).toEqual([expected])
  expect(view.get("#worktree-protection-description").text()).toContain("Keeps edits, untracked files, and ignored files")
  selects[1]!.vm.$emit("update:modelValue", "none")
  await flushPromises()
  expect(view.get("#worktree-protection-description").text()).toContain("Only committed changes can be restored")
  await view.get('[aria-label="Reset branch naming"]').trigger("click")
  await flushPromises()
  expect(selects[0]!.props("modelValue")).toBe("semantic")
})

test("offers reload after initial load failure", async () => {
  vi.mocked(platformClient.settings.getWorktreePreferences).mockRejectedValueOnce(new Error("Settings unavailable"))
  const view = render()
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Settings unavailable")
  const reload = view.findAll("button").find(button => button.text() === "Reload settings")!
  await reload.trigger("click")
  await flushPromises()
  expect(view.get('#worktree-archived-row [role="switch"]').attributes("disabled")).toBeUndefined()
})

test("explains archived cleanup and ignored-file protection in Chinese", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const view = render()
  await flushPromises()
  await expand(view)
  expect(view.get("#worktree-archived-label").text()).toBe("清理已归档会话的工作树")
  expect(view.get("#worktree-protection-description").text()).toContain("忽略的文件（包括 .env）会被删除")
})
