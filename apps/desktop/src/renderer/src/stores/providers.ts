import { defineStore } from "pinia"
import { onScopeDispose, ref } from "vue"
import type { AgentProviderConfig } from "../../../../../daemon/src/provider-protocol.ts"

/** The local daemon owns these settings; all windows refresh after a mutation. */
export const useProvidersStore = defineStore("providers", () => {
  const providers = ref<AgentProviderConfig[]>([])
  const selectedId = ref("")
  const ready = ref(false)
  /** Keep the last known provider identity even if a later refresh disconnects. */
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let refreshing: Promise<void> | null = null
  let refreshRequested = false
  let disposed = false

  function refresh(): Promise<void> {
    refreshRequested = true
    refreshing ??= (async () => {
      loading.value = true
      try {
        do {
          refreshRequested = false
          const snapshot = await window.deskfleet.providers.list()
          if (disposed) return
          if (refreshRequested) continue
          providers.value = snapshot.providers
          if (!providers.value.some(provider => provider.id === selectedId.value)) selectedId.value = providers.value[0]?.id ?? ""
          ready.value = true
          loaded.value = true
          error.value = null
        } while (refreshRequested)
      } catch (reason) {
        if (!disposed) {
          ready.value = false
          error.value = reason instanceof Error ? reason.message : String(reason)
        }
      } finally {
        loading.value = false
        refreshing = null
      }
    })()
    return refreshing
  }

  const unsubscribe = window.deskfleet.providers.onChanged(() => { void refresh() })
  onScopeDispose(() => { disposed = true; unsubscribe() })
  return { providers, selectedId, ready, loaded, loading, error, refresh }
})
