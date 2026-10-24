import { useLocalStorage } from "@vueuse/core"
import { computed, onScopeDispose, ref, watch } from "vue"
import type { AgentConfiguration, AgentConfigurationParams } from "../../../../shared/agent-configuration.ts"

/** Draft choices; the daemon resolves the available options through the selected agent. */
export function useAgentConfiguration(worktreeId: () => string | undefined) {
  const selection = useLocalStorage<Omit<AgentConfigurationParams, "worktreeId">>("deskfleet.agent-configuration", { provider: "codex" })
  const configuration = ref<AgentConfiguration | null>(null)
  const expanded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let requestId = 0
  onScopeDispose(() => { ++requestId })

  async function configure(choices = selection.value): Promise<void> {
    const currentRequest = ++requestId
    loading.value = true
    error.value = null
    try {
      const result = await window.deskfleet.agents.configuration({ ...choices, worktreeId: worktreeId() })
      if (currentRequest !== requestId) return
      configuration.value = result
      selection.value = {
        provider: result.provider.id,
        model: result.models?.currentValue,
        reasoningEffort: result.reasoningEfforts?.currentValue,
      }
    } catch (cause) {
      if (currentRequest === requestId) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (currentRequest === requestId) loading.value = false
    }
  }

  function toggle(): void {
    expanded.value = !expanded.value
    if (expanded.value && !configuration.value && !loading.value) void configure()
  }

  function changeModel(model: string): Promise<void> {
    // Let the agent select a supported effort for the new model.
    return configure({ provider: selection.value.provider, model })
  }

  function changeReasoningEffort(reasoningEffort: string): Promise<void> {
    return configure({ ...selection.value, reasoningEffort })
  }

  function reload(): Promise<void> {
    return configure({ provider: selection.value.provider })
  }

  watch(worktreeId, () => {
    ++requestId
    configuration.value = null
    error.value = null
    loading.value = false
    if (expanded.value) void configure()
  })

  const modelName = computed(() => configuration.value?.models?.options.find(option => option.id === configuration.value?.models?.currentValue)?.name ?? selection.value.model)
  const reasoningEffort = computed(() => configuration.value?.reasoningEfforts?.currentValue ?? selection.value.reasoningEffort)

  return { configuration, expanded, loading, error, modelName, reasoningEffort, toggle, changeModel, changeReasoningEffort, reload }
}
