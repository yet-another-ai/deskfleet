import { afterEach, expect, test } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"
import { i18n } from "../../i18n"
import { buildPromptContent } from "../../services/composer-attachments.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions"
import { agentInput } from "../../test/agent.ts"
import AgentUserMessage from "../session/AgentUserMessage.vue"
import GitDiffView from "./GitDiffView.vue"
import { createDiffAttachment, formatDiffSelectionLabel, isCommentableDiffLine, normalizeDiffSelection, parseGitDiffLines } from "./git-diff-lines"

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts", "index 1111111..2222222 100644", "--- a/src/app.ts", "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@", " const a = 1", "-const b = 2", "+const b = 20", "+const c = 30", " const d = 4",
  "@@ -10,2 +11,3 @@", " const x = 10", "+const y = 20",
].join("\n")

const makeDiff = (overrides: Partial<GitFileDiff> = {}): GitFileDiff => ({
  sessionId: "sess-1", repositoryId: "repo-1", path: "src/app.ts", kind: "unstaged", patch: PATCH, truncated: false, binary: false, ...overrides,
})

let wrapper: ReturnType<typeof mount> | null = null
let messageWrapper: ReturnType<typeof mount> | null = null
let host: HTMLElement | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  messageWrapper?.unmount()
  messageWrapper = null
  host?.remove()
  host = null
})

function mountDiff() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useAgentSessionsStore()
  host = document.createElement("div")
  host.innerHTML = '<textarea data-composer-input></textarea>'
  document.body.appendChild(host)
  const diffHost = document.createElement("div")
  host.appendChild(diffHost)
  wrapper = mount(GitDiffView, {
    attachTo: diffHost,
    props: { diff: makeDiff(), loading: false, error: null, connected: true },
    global: { plugins: [pinia, i18n], stubs: { teleport: { inheritAttrs: false, template: "<slot />" } } },
  })
  return { wrapper, store, textarea: host.querySelector<HTMLTextAreaElement>("[data-composer-input]")! }
}

test("selection helpers filter non-commentable lines, build prompt blocks, and render cleanly in AgentUserMessage", async () => {
  const lines = parseGitDiffLines(PATCH)
  expect([isCommentableDiffLine(lines[0]), isCommentableDiffLine(lines[4]), isCommentableDiffLine(lines[7])]).toEqual([false, false, true])
  expect(normalizeDiffSelection(lines, 3, 7)).toBeNull()
  expect(normalizeDiffSelection(lines, 7, 3)).toEqual({ startIndex: 5, endIndex: 7 })
  expect(formatDiffSelectionLabel(lines, { startIndex: 7, endIndex: 7 })).toBe("L2")
  expect(formatDiffSelectionLabel(parseGitDiffLines("@@ -5,3 +5,1 @@\n-a\n-b\n c"), { startIndex: 1, endIndex: 2 })).toBe("L5-L6")

  const attachment = createDiffAttachment(makeDiff({ path: "src/my file.ts" }), lines, { startIndex: 6, endIndex: 12 }, "att-1")
  const expectedUri = `deskfleet://git-diff/${encodeURIComponent("src/my file.ts · L2-L12")}`
  expect(attachment).toMatchObject({ id: "att-1", kind: "pasted_text", label: "src/my file.ts · L2-L12", uri: expectedUri })
  expect(attachment.text).toContain("@@ src/my file.ts (unstaged, L2-L12) @@")
  expect(attachment.text).not.toContain("@@ -10,2 +11,3 @@")

  const blocks = await buildPromptContent({ draft: "Split this", attachments: [attachment], sessionId: "sess-1" })
  expect(blocks).toEqual([
    { type: "resource", resource: { uri: expectedUri, mimeType: "text/plain", text: attachment.text } },
    { type: "text", text: "Split this" },
  ])

  messageWrapper = mount(AgentUserMessage, { props: { input: agentInput({ content: blocks }) }, global: { plugins: [i18n] } })
  expect(messageWrapper.text()).toContain("src/my file.ts · L2-L12")
  const toggle = messageWrapper.get("[data-pasted-resource] button")
  await toggle.trigger("click")
  expect(toggle.attributes("aria-expanded")).toBe("true")
  expect(messageWrapper.get("[data-pasted-resource]").text()).toContain("@@ src/my file.ts (unstaged, L2-L12) @@")
})

const labels = (store: ReturnType<typeof useAgentSessionsStore>) =>
  (store.draftAttachments["sess-1"] ?? []).map(a => ("label" in a ? a.label : a.kind))

test("clicking, toggling, splitting, Shift-clicking, cross-hunk dragging, and composer removal sync draftAttachments", async () => {
  const { wrapper, store, textarea } = mountDiff()
  const buttons = wrapper.findAll("[data-diff-line-select]")
  const selectedCount = () => wrapper.findAll('[data-line-selected="true"]').length

  await buttons[2]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L2"])
  expect(document.activeElement).toBe(textarea)

  await buttons[0]!.trigger("click", { shiftKey: true })
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L2"])
  expect(selectedCount()).toBe(3)

  await buttons[0]!.trigger("pointerdown", { button: 0 })
  await buttons[4]!.trigger("pointerenter")
  window.dispatchEvent(new PointerEvent("pointerup"))
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L4"])
  expect(selectedCount()).toBe(5)

  await buttons[2]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L2", "src/app.ts · L3-L4"])
  expect(selectedCount()).toBe(4)

  await buttons[2]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L4"])
  expect(selectedCount()).toBe(5)

  await buttons[4]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L3"])
  expect(selectedCount()).toBe(4)

  await buttons[0]!.trigger("pointerdown", { button: 0 })
  await buttons[6]!.trigger("pointerenter")
  window.dispatchEvent(new PointerEvent("pointerup"))
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1-L12"])
  expect(selectedCount()).toBe(7)

  await buttons[1]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual(["src/app.ts · L1", "src/app.ts · L2-L12"])
  expect(selectedCount()).toBe(6)

  store.draftAttachments["sess-1"] = store.draftAttachments["sess-1"]!.slice(0, 1)
  await flushPromises()
  expect(selectedCount()).toBe(1)

  await buttons[0]!.trigger("click")
  await flushPromises()
  expect(labels(store)).toEqual([])
  expect(selectedCount()).toBe(0)
})
