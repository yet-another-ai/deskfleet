import { computed, onScopeDispose, ref, toRef, watch, type Ref } from "vue"
import type { AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"

type Choices = Omit<AgentSelection, "provider">
interface DraftRequest { id: number; choices: Choices; restore?: Choices; resolve(): void }
interface ConfigurationProbe {
  params: { provider: string; workspaceId?: string; probeId: string; composer?: boolean }
  pending?: Promise<AgentConfiguration>
  next?: DraftRequest
  retired: boolean
}

/** Draft choices are local preferences; existing Sessions always use their live agent. */
export function useAgentConfiguration(target: () => { workspaceId?: string; sessionId?: string; providerId?: string }, draft?: Ref<AgentSelection>) {
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  const draftConfiguration = draft ?? toRef(agents, "draftConfiguration")
  const discovered = ref<AgentConfiguration | null>(null)
  const configuration = computed(() => target().sessionId ? agents.configurations[target().sessionId!] ?? null : discovered.value)
  const selection = computed(() => !target().sessionId && draftConfiguration.value.provider === target().providerId ? draftConfiguration.value : undefined)
  const expanded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const requestedModel = ref<string>()
  let requestId = 0
  let probe: ConfigurationProbe | undefined
  let confirmedTarget: { provider: string; workspaceId?: string } | undefined

  function retire(current = probe): void {
    if (!current || current.retired) return
    current.retired = true
    current.next?.resolve()
    current.next = undefined
    if (probe === current) probe = undefined
    // HTTP requests can arrive out of order. Release only after this probe's
    // submitted request settles; the daemon bounds cleanup if the client leaves.
    void (current.pending ?? Promise.resolve()).catch(() => {}).then(() => agents.releaseAgentConfiguration(current.params)).catch(() => {})
  }
  function newProbe(): ConfigurationProbe {
    const { workspaceId, providerId } = target()
    return probe = { params: { provider: providerId!, workspaceId, probeId: crypto.randomUUID() }, retired: false }
  }
  function confirm(result: AgentConfiguration, params: ConfigurationProbe["params"]): void {
    discovered.value = result
    confirmedTarget = { provider: params.provider, workspaceId: params.workspaceId }
    draftConfiguration.value = {
      provider: result.provider.id,
      model: result.models?.currentValue,
      reasoningEffort: result.reasoningEfforts?.currentValue,
      mode: result.modes?.currentValue,
    }
  }
  function takeNext(current: ConfigurationProbe): DraftRequest | undefined {
    const request = current.next
    current.next = undefined
    return request
  }
  async function readDraft(current: ConfigurationProbe): Promise<void> {
    if (current.pending || current.retired || !current.next) return
    const request = takeNext(current)!
    try {
      current.pending = agents.agentConfiguration({ ...request.choices, ...current.params, ...(request.restore && { restore: request.restore }) })
      const result = await current.pending
      const latest = target()
      if (request.id === requestId && !current.retired && !latest.sessionId
        && latest.providerId === current.params.provider && latest.workspaceId === current.params.workspaceId) confirm(result, current.params)
    } catch (cause) {
      const next = takeNext(current)
      retire(current)
      if (request.id === requestId) error.value = cause instanceof Error ? cause.message : String(cause)
      // A failed setter may have partially changed the probe. The latest queued
      // model gets a fresh probe; an obsolete failure must not replace its UI.
      if (next && next.id === requestId) {
        const replacement = newProbe()
        replacement.next = next
        void readDraft(replacement)
      } else next?.resolve()
    } finally {
      current.pending = undefined
      request.resolve()
      if (request.id === requestId) { loading.value = false; requestedModel.value = undefined }
      if (!current.retired) void readDraft(current)
    }
  }

  async function configure(choices?: Choices, composer = false): Promise<void> {
    const currentRequest = ++requestId
    const { workspaceId, sessionId, providerId } = target()
    if (!sessionId && !providerId) return
    loading.value = true
    error.value = null
    const changingModel = choices?.model !== undefined && choices.reasoningEffort === undefined && choices.mode === undefined
    requestedModel.value = !sessionId && changingModel && configuration.value?.models?.options.some(option => option.id === choices.model) ? choices.model : undefined
    if (!sessionId) {
      const current = probe ?? newProbe()
      if (composer) current.params.composer = true
      current.next?.resolve()
      const confirmed = discovered.value
      // A daemon may have expired this probe. Restore only this target's
      // confirmed choices before an explicit edit; reload still reads defaults.
      const restore = choices && Object.values(choices).some(value => value !== undefined) && confirmed && confirmed.provider.id === providerId
        && confirmedTarget?.provider === providerId && confirmedTarget.workspaceId === workspaceId ? {
        model: confirmed.models?.currentValue,
        reasoningEffort: confirmed.reasoningEfforts?.currentValue,
        mode: confirmed.modes?.currentValue,
      } : undefined
      return new Promise(resolve => {
        current.next = { id: currentRequest, choices: { ...(choices ?? selection.value) }, restore, resolve }
        void readDraft(current)
      })
    }
    try {
      if (choices) await agents.configureSession(sessionId, choices)
      else if (composer) await agents.sessionConfiguration(sessionId, true)
      else await agents.sessionConfiguration(sessionId)
    } catch (cause) {
      if (currentRequest === requestId) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (currentRequest === requestId) loading.value = false
    }
  }

  function toggle(): void {
    expanded.value = !expanded.value
    if (expanded.value && !loading.value && (target().sessionId || !configuration.value)) void configure()
  }
  function changeModel(model: string): Promise<void> {
    // The provider owns dependent effort/mode choices after a model change.
    return configure({ model })
  }
  function changeReasoningEffort(reasoningEffort: string): Promise<void> {
    return configure({ reasoningEffort })
  }
  function changeMode(mode: string): Promise<void> {
    return configure({ mode })
  }
  function reload(): Promise<void> {
    retire()
    return configure(target().sessionId ? undefined : {})
  }
  /** Completion discovery shares this composer's existing draft provider session. */
  async function discover(): Promise<void> {
    if (probe?.pending) await probe.pending.catch(() => {})
    await configure(undefined, true)
    if (error.value) throw new Error(error.value)
  }
  function invalidate(): void {
    ++requestId
    retire()
    discovered.value = null
    confirmedTarget = undefined
    error.value = null
    loading.value = false
    requestedModel.value = undefined
    if (expanded.value) void configure()
  }
  watch(() => [target().workspaceId, target().sessionId, target().providerId, providers.revision], (current, previous) => {
    const targetChanged = current.slice(0, 3).some((value, index) => value !== previous[index])
    // The first registry snapshot can arrive after discovery begins. Only a
    // changed known revision indicates edited settings or a restarted daemon.
    const settingsChanged = previous[3] !== undefined && current[3] !== undefined && current[3] !== previous[3]
    if (targetChanged || settingsChanged && !target().sessionId) invalidate()
  })
  onScopeDispose(() => { ++requestId; retire() })

  const modelValue = computed(() => requestedModel.value ?? configuration.value?.models?.currentValue)
  const modelName = computed(() => configuration.value?.models?.options.find(option => option.id === modelValue.value)?.name ?? modelValue.value ?? selection.value?.model)
  const reasoningEffort = computed(() => configuration.value?.reasoningEfforts?.currentValue ?? selection.value?.reasoningEffort)
  const modeName = computed(() => configuration.value?.modes?.options.find(option => option.id === configuration.value?.modes?.currentValue)?.name ?? configuration.value?.modes?.currentValue ?? selection.value?.mode)
  return { configuration, expanded, loading, error, modelName, modelValue, requestedModel, reasoningEffort, modeName, toggle, changeModel, changeReasoningEffort, changeMode, reload, discover }
}
