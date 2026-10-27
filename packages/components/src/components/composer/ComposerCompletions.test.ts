import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { defineComponent } from "vue"
import type { AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import type { ComposerReferenceResult } from "../../../../../apps/daemon/src/composer-reference-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import type { ComposerMention } from "../../services/composer-mentions.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { WorkspaceLocation } from "../../stores/fleet.ts"
import SessionComposer from "./SessionComposer.vue"

let pinia: ReturnType<typeof createPinia> | undefined
const wrappers: VueWrapper[] = []
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  if (pinia) disposePinia(pinia)
  pinia = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const location: WorkspaceLocation = {
  machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
  workspace: { id: "1", name: "Deskfleet", directories: [{ path: "/repo" }], sessions: [], terminals: [] },
}
const fileResult: ComposerReferenceResult = { items: [{ name: "README.md", description: "/repo/README.md", reference: { kind: "file", originId: "origin", workspaceId: "1", directoryIndex: 0, sourceDirectory: "/repo", relativePath: "README.md" } }], truncated: false }
const sessionResult: ComposerReferenceResult = { items: [{ name: "Earlier design", description: "Archived session", archived: true, reference: { kind: "session", originId: "origin", workspaceId: "1", sessionId: "30" } }], truncated: false }

function fixture(configuration?: AgentConfiguration) {
  vi.useFakeTimers()
  pinia = createPinia()
  setActivePinia(pinia)
  const agents = useAgentSessionsStore()
  const search = vi.spyOn(agents, "composerReferences").mockImplementation(async params => params.kind === "file" ? fileResult : sessionResult)
  const discover = vi.fn()
  const selector = defineComponent({
    emits: ["configuration"],
    setup(_, { emit, expose }) {
      expose({ discover: async () => { discover(); emit("configuration", configuration ? structuredClone(configuration) : null) } })
      return () => null
    },
  })
  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: { location, modelValue: "", mentions: [], canSteer: true,
      "onUpdate:modelValue": (value: string) => { void wrapper.setProps({ modelValue: value }) },
      "onUpdate:mentions": (mentions: ComposerMention[]) => { void wrapper.setProps({ mentions }) },
    },
    global: { plugins: [pinia, i18n], stubs: { AgentConfigurationSelector: selector } },
  })
  wrappers.push(wrapper)
  const textarea = wrapper.get<HTMLTextAreaElement>("textarea")
  async function type(value: string, caret = value.length): Promise<void> {
    await textarea.trigger("focus")
    textarea.element.value = value
    textarea.element.setSelectionRange(caret, caret)
    await textarea.trigger("input")
    await vi.advanceTimersByTimeAsync(151)
    await flushPromises()
  }
  return { wrapper, textarea, type, search, discover }
}

test("@ completions group files and sessions; keyboard selection records a reference, and removing its chip removes its token", async () => {
  const { wrapper, textarea, type, search } = fixture()
  await type("Read @")
  expect(search).toHaveBeenCalledWith({ workspaceId: "1", kind: "file", query: "", limit: 12 })
  expect(wrapper.get('[role="group"][aria-label="Files"]').text()).toContain("README.md")
  expect(wrapper.get('[role="group"][aria-label="Sessions"]').text()).toContain("Earlier design")
  await textarea.trigger("keydown", { key: "ArrowDown" })
  await textarea.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(wrapper.emitted("submit")).toBeUndefined()
  expect(wrapper.props("modelValue")).toBe("Read @Earlier design ")
  expect(wrapper.props("mentions")?.[0]?.reference).toEqual(sessionResult.items[0]!.reference)
  expect(wrapper.find("[data-composer-completions]").exists()).toBe(false)
  await wrapper.get('[data-mention-kind="session"] button').trigger("click")
  expect(wrapper.props("modelValue")).toBe("Read  ")
  expect(wrapper.props("mentions")).toEqual([])
})

test("editing a selected token removes its reference, Escape preserves literal text, and IME Enter never submits", async () => {
  const { wrapper, textarea, type } = fixture()
  await type("Read @")
  await textarea.trigger("keydown", { key: "Tab" })
  await flushPromises()
  expect(wrapper.props("mentions")).toHaveLength(1)
  await type("Read @CHANGES.md ")
  expect(wrapper.props("mentions")).toEqual([])
  await type("Read @other")
  await textarea.trigger("keydown", { key: "Escape" })
  expect(wrapper.find("[data-composer-completions]").exists()).toBe(false)
  expect(wrapper.props("modelValue")).toBe("Read @other")
  await textarea.trigger("compositionstart")
  await textarea.trigger("keydown", { key: "Enter", isComposing: true })
  expect(wrapper.emitted("submit")).toBeUndefined()
})

test("late results from a previous query cannot replace current suggestions", async () => {
  const { wrapper, type, search } = fixture()
  let finish!: (value: ComposerReferenceResult) => void
  search.mockImplementation(params => params.query === "old"
    ? new Promise(resolve => { if (params.kind === "file") finish = resolve; else resolve({ items: [], truncated: false }) })
    : Promise.resolve(params.kind === "file" ? { ...fileResult, items: [{ ...fileResult.items[0]!, name: "new.ts", description: "/repo/new.ts" }] } : { items: [], truncated: false }))
  await type("@old")
  await type("@new")
  expect(wrapper.get("[data-composer-completions]").text()).toContain("new.ts")
  finish(fileResult)
  await flushPromises()
  expect(wrapper.get("[data-composer-completions]").text()).toContain("new.ts")
  expect(wrapper.get("[data-composer-completions]").text()).not.toContain("README.md")
})

test("Enter waits for pending reference suggestions instead of submitting a literal query", async () => {
  const { wrapper, textarea, type, search } = fixture()
  let finish!: (value: ComposerReferenceResult) => void
  search.mockImplementation(params => params.kind === "file" ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ items: [], truncated: false }))
  await type("Read @read")
  expect(wrapper.get('[role="listbox"]').attributes("aria-busy")).toBe("true")
  await textarea.trigger("keydown", { key: "Enter" })
  expect(wrapper.emitted("submit")).toBeUndefined()
  expect(wrapper.props("modelValue")).toBe("Read @read")
  finish(fileResult)
  await flushPromises()
  await textarea.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(wrapper.props("modelValue")).toBe("Read @README.md ")
})

test("reopening provider completions discovers newly available commands without discovering on every keystroke", async () => {
  const configuration: AgentConfiguration = { provider: { id: "test", name: "Test" }, models: null, modes: null, reasoningEfforts: null, commands: [], skills: [] }
  const { wrapper, textarea, type, discover } = fixture(configuration)
  await type("/co")
  await type("/com")
  expect(discover).toHaveBeenCalledTimes(1)
  expect(wrapper.findAll('[data-completion-kind="command"]')).toHaveLength(0)
  await textarea.trigger("keydown", { key: "Escape" })
  configuration.commands = [{ name: "compact", description: "Compact context" }]
  await type("/co")
  expect(discover).toHaveBeenCalledTimes(2)
  expect(wrapper.get('[data-completion-kind="command"]').text()).toContain("/compact")
})

test("command and skill completion shares configuration discovery, limits slash skills to the beginning, and queues commands", async () => {
  const configuration: AgentConfiguration = {
    provider: { id: "test", name: "Test" }, models: null, modes: null, reasoningEfforts: null,
    commands: [{ name: "compact", description: "Compact context", inputHint: "Focus" }],
    skills: [{ id: "native", name: "native", description: "Native skill", invocation: "$native" }, { id: "review", name: "review", description: "Review code", invocation: "/skill:review" }],
  }
  const { wrapper, textarea, type, discover } = fixture(configuration)
  await type("/co")
  expect(discover).toHaveBeenCalledTimes(1)
  expect(wrapper.get('[data-completion-kind="command"]').text()).toContain("/compact")
  await textarea.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(wrapper.props("modelValue")).toBe("/compact ")
  expect(wrapper.find("button:has(.lucide-corner-down-right)").exists()).toBe(false)
  await wrapper.get('button[aria-label="Send"]').trigger("click")
  expect(wrapper.emitted("submit")?.at(-1)).toEqual(["backlog"])
  await type("Use $")
  expect(wrapper.findAll('[data-completion-kind="skill"]')).toHaveLength(1)
  expect(wrapper.get('[data-completion-kind="skill"]').text()).toContain("$native")
  await textarea.trigger("keydown", { key: "Tab" })
  await flushPromises()
  await wrapper.get("button:has(.lucide-corner-down-right)").trigger("click")
  expect(wrapper.emitted("submit")?.at(-1)).toEqual(["steer"])
  await type("$rev")
  await textarea.trigger("keydown", { key: "Tab" })
  await flushPromises()
  expect(wrapper.props("mentions")?.[0]?.reference).toMatchObject({ kind: "skill", invocation: "/skill:review", providerId: "test" })
  expect(wrapper.find("button:has(.lucide-corner-down-right)").exists()).toBe(false)
  await wrapper.get('button[aria-label="Send"]').trigger("click")
  expect(wrapper.emitted("submit")?.at(-1)).toEqual(["backlog"])
  await type("Continue with the tests")
  await wrapper.get("button:has(.lucide-corner-down-right)").trigger("click")
  expect(wrapper.emitted("submit")?.at(-1)).toEqual(["steer"])
})
