import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { defineStore } from "pinia"
import { onScopeDispose, ref } from "vue"
import type { ProviderDisplay } from "@deskfleet/client/providers"

/** Draft Agent choices persist separately; restore that provider when this process has not chosen one. */
function persistedDraftProvider(): string {
  const storage = globalThis.localStorage
  if (!storage) return ""
  try {
    const raw = storage.getItem("deskfleet.agent-configuration")
    if (!raw) return ""
    const parsed = JSON.parse(raw) as { provider?: unknown }
    return typeof parsed.provider === "string" ? parsed.provider : ""
  } catch {
    return ""
  }
}

/** The local daemon owns these settings; all windows refresh after a mutation. */
export const useProvidersStore = defineStore("providers", () => {
  const platformClient = usePlatformClient()
  const providers = ref<ProviderDisplay[]>([])
  const revision = ref<string>()
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
          const snapshot = await (platformClient.providers.display?.() ?? platformClient.providers.list())
          if (disposed) return
          if (refreshRequested) continue
          providers.value = snapshot.providers
          if (snapshot.revision !== undefined) revision.value = snapshot.revision
          if (!providers.value.some(provider => provider.id === selectedId.value)) {
            const remembered = persistedDraftProvider()
            selectedId.value = providers.value.find(provider => provider.id === remembered)?.id ?? providers.value[0]?.id ?? ""
          }
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

  const unsubscribe = platformClient.providers.onChanged(() => { void refresh() })
  onScopeDispose(() => { disposed = true; unsubscribe() })
  return { providers, revision, selectedId, ready, loaded, loading, error, refresh }
})
