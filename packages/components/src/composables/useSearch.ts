import { useDebounceFn } from "@vueuse/core"
import { computed, onScopeDispose, ref, watch, type Ref } from "vue"
import type { SearchKind, SearchResult } from "@deskfleet/client/search"
import { useAccountSession } from "./useAccountSession.ts"
import { useSearchFeature } from "../services/search-feature.ts"

export type { SearchKind } from "@deskfleet/client/search"

/** Results belong to the selected Team and query, even while an older request is in flight. */
export function useSearch(query: Ref<string>, kind: Ref<SearchKind>) {
  const account = useAccountSession()
  const enabled = useSearchFeature()
  const results = ref<SearchResult[]>([])
  const nextCursor = ref<string>()
  const loading = ref(false)
  const error = ref<string>()
  const available = computed(() => enabled.value && !!account?.teamId.value)
  let revision = 0
  let disposed = false

  async function search(more = false): Promise<void> {
    const teamId = account?.teamId.value
    const q = query.value.trim()
    if (disposed || !enabled.value || !account || !teamId || !q || (more && (!nextCursor.value || loading.value))) return
    const current = ++revision
    loading.value = true
    error.value = undefined
    try {
      const page = await account.central.search(teamId, { q, kind: kind.value, limit: 30, ...(more ? { cursor: nextCursor.value } : {}) })
      if (disposed || current !== revision) return
      results.value = more ? [...results.value, ...page.results] : page.results
      nextCursor.value = page.nextCursor
    } catch (reason) {
      if (!disposed && current === revision) error.value = reason instanceof Error ? reason.message : String(reason)
    } finally {
      if (!disposed && current === revision) loading.value = false
    }
  }
  const delayedSearch = useDebounceFn(() => search(), 250)
  watch([query, kind, enabled, () => account?.teamId.value], () => {
    ++revision
    delayedSearch.cancel()
    results.value = []
    nextCursor.value = undefined
    error.value = undefined
    loading.value = available.value && !!query.value.trim()
    if (loading.value) void delayedSearch()
  }, { immediate: true, flush: "sync" })
  onScopeDispose(() => { disposed = true; ++revision; delayedSearch.cancel() })
  function refresh(): Promise<void> { delayedSearch.cancel(); return search() }
  return { results, nextCursor, loading, error, available, enabled, refresh, loadMore: () => search(true) }
}
