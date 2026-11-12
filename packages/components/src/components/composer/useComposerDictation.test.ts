import type { SpeechApi, SpeechEvent } from "@deskfleet/client/speech"
import { flushPromises } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { effectScope, ref } from "vue"
import type { ComposerMention } from "../../services/composer-mentions.ts"
import { useComposerDictation } from "./useComposerDictation.ts"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function fixture(text = "", start = text.length, end = start) {
  let listener: ((event: SpeechEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const api: SpeechApi = {
    status: vi.fn(async () => ({ supported: true })),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onEvent: callback => { listener = callback; return unsubscribe },
  }
  const draft = ref(text)
  const mentions = ref<ComposerMention[]>([])
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setSelectionRange(start, end)
  const enabled = ref(true), disabled = ref(false), scope = ref("team:machine:session"), locale = ref("en-US")
  const owner = effectScope()
  const dictation = owner.run(() => useComposerDictation({
    api, draft, mentions, textarea: ref(textarea), enabled,
    locale: () => locale.value, scope: () => scope.value, disabled: () => disabled.value,
  }))!
  cleanups.push(() => owner.stop())
  await flushPromises()
  const id = () => vi.mocked(api.start).mock.calls.at(-1)![0].sessionId
  const emit = (event: Omit<SpeechEvent, "sessionId">, sessionId = id()) => listener?.({ ...event, sessionId } as SpeechEvent)
  return { api, owner, dictation, enabled, disabled, scope, locale, draft, mentions, emit, id, unsubscribe }
}

test("previews cumulative results and commits the latest final once at the selection, retaining mentions", async () => {
  const f = await fixture("old @file", 0, 3)
  f.mentions.value = [{ id: "file", start: 4, end: 9, token: "@file", reference: { kind: "file", originId: "origin", workspaceId: "workspace", directoryIndex: 0, sourceDirectory: "/", relativePath: "file" } }]
  await f.dictation.toggle()
  f.emit({ type: "started" })
  f.emit({ type: "result", text: "new", final: false } as SpeechEvent)
  expect(f.draft.value).toBe("old @file")
  expect(f.dictation.transcript.value).toBe("new")
  f.emit({ type: "result", text: "new text", final: true } as SpeechEvent)
  f.emit({ type: "result", text: "new text pending", final: false } as SpeechEvent)
  await f.dictation.toggle()
  expect(f.api.stop).toHaveBeenCalledWith(f.id())
  f.emit({ type: "ended" })
  f.emit({ type: "ended" })
  expect(f.draft.value).toBe("new text @file")
  expect(f.mentions.value[0]).toMatchObject({ start: 9, end: 14 })
  expect(f.dictation.active.value).toBe(false)
})

test("preserves concurrent typing around and over the selected insertion range", async () => {
  const f = await fixture("replace tail", 0, 7)
  await f.dictation.toggle()
  f.draft.value = "my edit tail"
  f.emit({ type: "result", text: " voice", final: true } as SpeechEvent)
  f.emit({ type: "ended" })
  expect(f.draft.value).toBe("my edit voice tail")
  const g = await fixture("before end", 7)
  await g.dictation.toggle()
  g.draft.value = "typed before end"
  g.emit({ type: "result", text: "VOICE", final: true } as SpeechEvent)
  g.emit({ type: "ended" })
  expect(g.draft.value).toBe("typed before VOICE end")
})

test("joins dictated Chinese without inserting word spaces", async () => {
  const f = await fixture("请修复")
  await f.dictation.toggle()
  f.emit({ type: "result", text: "这个问题", final: true } as SpeechEvent)
  f.emit({ type: "ended" })
  expect(f.draft.value).toBe("请修复这个问题")
})

test.each(["scope", "enabled", "disabled", "locale", "unmount"] as const)("cancels on %s and rejects late results", async change => {
  const f = await fixture("draft")
  await f.dictation.toggle()
  const id = f.id()
  f.emit({ type: "result", text: "first", final: true } as SpeechEvent)
  if (change === "scope") f.scope.value = "another-team:machine:session"
  if (change === "enabled") f.enabled.value = false
  if (change === "disabled") f.disabled.value = true
  if (change === "locale") f.locale.value = "ja-JP"
  if (change === "unmount") f.owner.stop()
  f.emit({ type: "result", text: "late", final: true } as SpeechEvent, id)
  f.emit({ type: "ended" }, id)
  expect(f.draft.value).toBe("draft")
  expect(f.api.cancel).toHaveBeenCalledWith(id)
  expect(f.dictation.active.value).toBe(false)
  if (change === "unmount") expect(f.unsubscribe).toHaveBeenCalledOnce()
})

test("uses actual levels and cancels when the page is hidden", async () => {
  const f = await fixture()
  await f.dictation.toggle()
  expect(f.dictation.levels.value.every(value => value === 0)).toBe(true)
  f.emit({ type: "level", level: 0.75 } as SpeechEvent)
  expect(f.dictation.levels.value.at(-1)).toBe(0.75)
  window.dispatchEvent(new Event("pagehide"))
  expect(f.api.cancel).toHaveBeenCalledWith(f.id())
})

test("a canceled pending start is stopped when permission resolves; errors discard pending text", async () => {
  const f = await fixture("draft")
  let resolve!: () => void
  vi.mocked(f.api.start).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  const pending = f.dictation.toggle()
  f.dictation.cancel()
  resolve()
  await pending
  expect(f.api.cancel).toHaveBeenCalledTimes(2)
  await f.dictation.toggle()
  f.emit({ type: "result", text: "discard", final: true } as SpeechEvent)
  f.emit({ type: "error", code: "permission-denied" } as SpeechEvent)
  f.emit({ type: "ended" })
  expect(f.draft.value).toBe("draft")
  expect(f.dictation.error.value).toBe("permission-denied")
})
