import type { SpeechApi, SpeechEvent } from "@deskfleet/client/speech"
import { useEventListener } from "@vueuse/core"
import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from "vue"
import { reconcileComposerMentions, type ComposerMention } from "../../services/composer-mentions.ts"

type SpeechError = Extract<SpeechEvent, { type: "error" }>["code"]
interface DictationOptions {
  api?: SpeechApi
  enabled: Ref<boolean>
  locale: () => string
  scope: () => string
  disabled: () => boolean
  draft: Ref<string>
  mentions: Ref<ComposerMention[]>
  textarea: Readonly<Ref<HTMLTextAreaElement | null>>
}

interface Recording {
  id: string
  start: number
  end: number
  draft: string
  mentions: ComposerMention[]
  hasResult: boolean
}

/** Recognition updates replace the dictated range directly inside the editable draft. */
export function useComposerDictation(options: DictationOptions) {
  const supported = ref(false)
  const state = ref<"idle" | "starting" | "listening" | "stopping">("idle")
  const levels = ref<number[]>(Array.from({ length: 18 }, () => 0))
  const error = ref<SpeechError>()
  const active = computed(() => state.value !== "idle")
  const visible = computed(() => options.enabled.value && supported.value)
  let recording: Recording | undefined
  let disposed = false
  let statusGeneration = 0
  let selectionGeneration = 0

  function cancel(): void {
    const previous = recording
    recording = undefined
    state.value = "idle"
    selectionGeneration++
    levels.value = levels.value.map(() => 0)
    if (previous) void options.api?.cancel(previous.id).catch(() => {})
  }

  function fail(code: SpeechError): void {
    cancel()
    error.value = code
  }

  useEventListener(document, "visibilitychange", () => { if (document.hidden) cancel() })
  useEventListener(window, "pagehide", cancel)

  function updateDraft(current: Recording, recognized: string): void {
    const text = recognized.trim()
    if (!text && !current.hasResult) return
    const before = current.draft
    const prefix = before.slice(0, current.start), suffix = before.slice(current.end)
    const word = /[\p{Script=Latin}\p{N}]/u
    const leading = word.test(prefix.at(-1) ?? "") && word.test(text[0] ?? "") ? " " : ""
    const trailing = word.test(text.at(-1) ?? "") && word.test(suffix[0] ?? "") ? " " : ""
    const inserted = leading + text + trailing
    const after = prefix + inserted + suffix
    // defineModel can echo its parent update on the next tick. Keep successive
    // recognition events in the same tick attached to the latest emitted draft.
    const mentions = options.draft.value === before ? options.mentions.value : current.mentions
    current.mentions = reconcileComposerMentions(before, after, mentions)
    current.draft = after
    current.end = current.start + inserted.length
    current.hasResult = true
    options.mentions.value = current.mentions
    options.draft.value = after
    const scope = options.scope()
    const generation = ++selectionGeneration
    void nextTick(() => {
      if (disposed || generation !== selectionGeneration || options.scope() !== scope || options.draft.value !== after) return
      options.textarea.value?.focus()
      options.textarea.value?.setSelectionRange(current.end, current.end)
    })
  }

  const unsubscribe = options.api?.onEvent(event => {
    const current = recording
    if (!current || event.sessionId !== current.id) return
    switch (event.type) {
      case "started": if (state.value === "starting") state.value = "listening"; break
      case "result": updateDraft(current, event.text); break
      case "level": levels.value = [...levels.value.slice(1), Math.max(0, Math.min(1, event.level))]; break
      case "error": fail(event.code); break
      case "ended": recording = undefined; state.value = "idle"; break
    }
  })

  watch([options.locale, () => options.enabled.value], async ([locale, enabled]) => {
    const generation = ++statusGeneration
    supported.value = false
    if (!enabled || !options.api) return
    try {
      const status = await options.api.status(locale)
      if (!disposed && generation === statusGeneration) supported.value = status.supported
    } catch { /* A capability probe cannot offer an unavailable speech service. */ }
  }, { immediate: true })

  watch([options.scope, options.locale, () => options.enabled.value, options.disabled], () => {
    cancel()
    error.value = undefined
  }, { flush: "sync" })

  // Edits around dictated text move its range; editing the text itself takes
  // ownership away from recognition so subsequent hypotheses cannot overwrite it.
  watch(options.draft, after => {
    const current = recording
    if (!current || current.draft === after) return
    const before = current.draft
    current.draft = after
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let oldEnd = before.length, newEnd = after.length
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
    if (oldEnd <= current.start) {
      current.start += newEnd - oldEnd
      current.end += newEnd - oldEnd
    } else if (start < current.end) {
      if (current.hasResult) cancel()
      else current.start = current.end = newEnd
    }
  }, { flush: "sync" })

  async function toggle(): Promise<void> {
    if (state.value === "stopping") return
    if (recording) {
      const current = recording
      state.value = "stopping"
      try { await options.api?.stop(current.id) }
      catch { if (recording === current) fail("failed") }
      return
    }
    if (!visible.value || options.disabled() || !options.api) return
    const input = options.textarea.value
    const current: Recording = {
      id: crypto.randomUUID(),
      start: input?.selectionStart ?? options.draft.value.length,
      end: input?.selectionEnd ?? options.draft.value.length,
      draft: options.draft.value,
      mentions: options.mentions.value,
      hasResult: false,
    }
    recording = current
    state.value = "starting"
    error.value = undefined
    levels.value = levels.value.map(() => 0)
    try {
      await options.api.start({ sessionId: current.id, locale: options.locale() })
      if (recording !== current) await options.api.cancel(current.id)
    } catch (reason) {
      if (recording !== current) return
      const code = typeof reason === "object" && reason && "code" in reason ? reason.code : undefined
      fail(code === "permission-denied" || code === "unavailable" || code === "no-speech" || code === "network" ? code : "failed")
    }
  }

  onScopeDispose(() => { disposed = true; statusGeneration++; cancel(); unsubscribe?.() })
  return { supported, visible, state, active, levels, error, toggle, cancel }
}
