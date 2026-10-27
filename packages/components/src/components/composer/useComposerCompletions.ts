import { useDebounceFn } from "@vueuse/core"
import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from "vue"
import type { AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { composerTrigger, reconcileComposerMentions, validComposerMentions, type ComposerMention } from "../../services/composer-mentions.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { SessionTarget } from "../../stores/fleet.ts"
import { useProvidersStore } from "../../stores/providers.ts"

export interface ComposerCandidate {
  key: string
  kind: "file" | "session" | "skill" | "command"
  name: string
  description: string
  token: string
  reference?: ComposerMention["reference"]
}

export function useComposerCompletions(options: {
  draft: Ref<string>
  mentions: Ref<ComposerMention[]>
  textarea: Readonly<Ref<HTMLTextAreaElement | null>>
  location(): SessionTarget | null
  disabled(): boolean
  configuration: Ref<AgentConfiguration | null>
  discover(): Promise<void>
}) {
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  const focused = ref(false)
  const composing = ref(false)
  const caret = ref(0)
  const dismissed = ref<string>()
  const references = ref<ComposerCandidate[]>([])
  const loading = ref(false)
  const error = ref<string>()
  const truncated = ref(false)
  const selected = ref(0)
  let generation = 0
  let discoveryKey = ""
  let discovery: Promise<void> | undefined
  const targetKey = computed(() => {
    const target = options.location()
    const provider = target?.session ? agents.sessions[target.session.id]?.provider : providers.selectedId
    return `${target?.machine.id}:${target?.workspace?.id}:${target?.session?.id}:${provider}:${providers.revision}`
  })
  const detected = computed(() => focused.value && !composing.value && !options.disabled()
    ? composerTrigger(options.draft.value, caret.value, options.mentions.value) : null)
  const triggerKey = computed(() => detected.value ? `${targetKey.value}:${JSON.stringify(detected.value)}` : "")
  const trigger = computed(() => triggerKey.value !== dismissed.value ? detected.value : null)
  const candidates = computed<ComposerCandidate[]>(() => {
    const current = trigger.value
    if (!current) return []
    if (current.kind === "reference") return references.value
    const configuration = options.configuration.value
    const query = current.query.toLocaleLowerCase()
    if (current.kind === "command") return (configuration?.commands ?? []).filter(command => command.name.toLocaleLowerCase().includes(query)).map(command => ({
      key: `command:${command.name}`, kind: "command", name: `/${command.name}`, description: [command.description, command.inputHint].filter(Boolean).join(" · "), token: `/${command.name}`,
    }))
    return (configuration?.skills ?? []).filter(skill => skill.name.toLocaleLowerCase().includes(query)
      && (!skill.invocation.startsWith("/") || !options.draft.value.slice(0, current.start).trim())).map(skill => ({
      key: `skill:${skill.id}`, kind: "skill", name: `$${skill.name}`, description: skill.description, token: `$${skill.name}`,
      reference: { kind: "skill", id: skill.id, name: skill.name, invocation: skill.invocation, providerId: configuration!.provider.id },
    }))
  })

  const search = useDebounceFn(async (request: number) => {
    const current = trigger.value
    const target = options.location()
    if (request !== generation || current?.kind !== "reference") return
    if (!target?.session && !target?.workspace) { loading.value = false; return }
    const scope = target.session ? { sessionId: target.session.id } : { workspaceId: target.workspace!.id }
    const results = await Promise.allSettled((["file", "session"] as const).map(kind => agents.composerReferences({ ...scope, kind, query: current.query, limit: 12 })))
    if (request !== generation) return
    references.value = results.flatMap(result => result.status === "fulfilled" ? result.value.items.map(item => ({
      key: JSON.stringify(item.reference), kind: item.reference.kind, name: item.name, description: item.description,
      token: `@${item.name}`, reference: item.reference,
    })) : [])
    truncated.value = results.some(result => result.status === "fulfilled" && result.value.truncated)
    const failure = results.find(result => result.status === "rejected")
    error.value = failure?.status === "rejected" ? String(failure.reason instanceof Error ? failure.reason.message : failure.reason) : undefined
    loading.value = false
  }, 150)

  watch([triggerKey, () => !!trigger.value], async () => {
    const request = ++generation
    search.cancel()
    references.value = []
    error.value = undefined
    truncated.value = false
    selected.value = 0
    const current = trigger.value
    if (!current) { loading.value = false; discoveryKey = ""; discovery = undefined; return }
    if (current.kind === "reference") { discoveryKey = ""; discovery = undefined; loading.value = true; void search(request); return }
    const key = `${targetKey.value}:${current.kind}`
    if (discoveryKey !== key) {
      discoveryKey = key
      discovery = options.discover()
    }
    if (!discovery) { loading.value = false; return }
    const currentDiscovery = discovery
    loading.value = true
    try { await currentDiscovery }
    catch (reason) {
      if (request === generation) error.value = reason instanceof Error ? reason.message : String(reason)
      if (discovery === currentDiscovery) discoveryKey = ""
    } finally {
      if (discovery === currentDiscovery) discovery = undefined
      if (request === generation) loading.value = false
    }
  })
  watch(candidates, () => { selected.value = Math.min(selected.value, Math.max(0, candidates.value.length - 1)) })
  onScopeDispose(() => { generation++; search.cancel() })

  function cursor(): void {
    const input = options.textarea.value
    caret.value = input && input.selectionStart === input.selectionEnd ? input.selectionStart : -1
  }
  function input(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value
    options.mentions.value = reconcileComposerMentions(options.draft.value, value, options.mentions.value)
    options.draft.value = value
    dismissed.value = undefined
    cursor()
  }
  async function accept(candidate = candidates.value[selected.value]): Promise<void> {
    const current = trigger.value
    if (!current || !candidate) return
    const before = options.draft.value
    const inserted = `${candidate.token} `
    const after = before.slice(0, current.start) + inserted + before.slice(current.end)
    const retained = reconcileComposerMentions(before, after, options.mentions.value)
    if (candidate.reference) retained.push({ id: crypto.randomUUID(), start: current.start, end: current.start + candidate.token.length, token: candidate.token, reference: candidate.reference })
    options.draft.value = after
    options.mentions.value = retained
    caret.value = current.start + inserted.length
    await nextTick()
    options.textarea.value?.focus()
    options.textarea.value?.setSelectionRange(caret.value, caret.value)
  }
  function remove(id: string): void {
    const mention = validComposerMentions(options.draft.value, options.mentions.value).find(value => value.id === id)
    if (!mention) { options.mentions.value = options.mentions.value.filter(value => value.id !== id); return }
    const before = options.draft.value
    const after = before.slice(0, mention.start) + before.slice(mention.end)
    options.mentions.value = reconcileComposerMentions(before, after, options.mentions.value.filter(value => value.id !== id))
    options.draft.value = after
  }
  function keydown(event: KeyboardEvent): boolean {
    if (event.isComposing || composing.value) return true
    if (!trigger.value) return false
    if (event.key === "Escape") { event.preventDefault(); dismissed.value = triggerKey.value; return true }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (candidates.value.length) selected.value = (selected.value + (event.key === "ArrowDown" ? 1 : -1) + candidates.value.length) % candidates.value.length
      return true
    }
    if (event.key === "Enter" && !event.shiftKey && loading.value) { event.preventDefault(); return true }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && candidates.value.length) { event.preventDefault(); void accept(); return true }
    return false
  }
  return { focused, composing, trigger, candidates, loading, error, truncated, selected, cursor, input, accept, remove, keydown }
}
