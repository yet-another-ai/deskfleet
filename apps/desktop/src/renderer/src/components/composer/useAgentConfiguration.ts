import { computed, onScopeDispose, ref, watch } from "vue"
import type { AgentConfiguration } from "../../../../shared/agent-configuration.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"

/** Draft choices are local preferences; existing Sessions always use their live agent. */
export function useAgentConfiguration(target: () => { workspaceId?: string; sessionId?: string; providerId?: string }) {
  const agents = useAgentSessionsStore()
  const discovered = ref<AgentConfiguration | null>(null)
  const configuration = computed(() => target().sessionId ? agents.configurations[target().sessionId!] ?? null : discovered.value)
  const selection = computed(() => !target().sessionId && agents.draftConfiguration.provider === target().providerId ? agents.draftConfiguration : undefined)
  const expanded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let requestId = 0
  onScopeDispose(() => { ++requestId })

  async function configure(choices?: Omit<AgentSelection, "provider">): Promise<void> {
    const currentRequest = ++requestId
    const { workspaceId, sessionId, providerId } = target()
    if (!sessionId && !providerId) return
    loading.value = true
    error.value = null
    try {
      const result = sessionId
        ? choices ? await agents.configureSession(sessionId, { model: choices.model, reasoningEffort: choices.reasoningEffort }) : await agents.sessionConfiguration(sessionId)
        : await agents.agentConfiguration({ ...(choices ?? selection.value), provider: providerId!, workspaceId })
      if (currentRequest !== requestId) return
      if (!sessionId) {
        discovered.value = result
        agents.draftConfiguration = {
          provider: result.provider.id,
          model: result.models?.currentValue,
          reasoningEffort: result.reasoningEfforts?.currentValue,
        }
      }
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
    // Let the agent select a supported effort for the new model.
    return configure({ model })
  }
  function changeReasoningEffort(reasoningEffort: string): Promise<void> {
    return configure({ ...(!target().sessionId && { model: configuration.value?.models?.currentValue }), reasoningEffort })
  }
  function reload(): Promise<void> {
    return configure(target().sessionId ? undefined : {})
  }
  watch(() => [target().workspaceId, target().sessionId, target().providerId], () => {
    ++requestId
    discovered.value = null
    error.value = null
    loading.value = false
    if (expanded.value) void configure()
  })

  const modelName = computed(() => configuration.value?.models?.options.find(option => option.id === configuration.value?.models?.currentValue)?.name ?? configuration.value?.models?.currentValue ?? selection.value?.model)
  const reasoningEffort = computed(() => configuration.value?.reasoningEfforts?.currentValue ?? selection.value?.reasoningEffort)
  return { configuration, expanded, loading, error, modelName, reasoningEffort, toggle, changeModel, changeReasoningEffort, reload }
}
