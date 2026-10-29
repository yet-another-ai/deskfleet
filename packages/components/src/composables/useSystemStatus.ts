import { usePlatformClient } from "./usePlatformClient.ts"
import { useDocumentVisibility, useIntervalFn, watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, toValue, type MaybeRefOrGetter } from "vue"
import type { SystemStatus } from "../../../client/src/system.ts"

export const SYSTEM_STATUS_INTERVAL = 2_000
export const SYSTEM_STATUS_HISTORY = 60_000

/** A visible machine panel owns its transient samples and polling lifetime. */
export function useSystemStatus(machineId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const client = usePlatformClient()
  const visibility = useDocumentVisibility()
  const available = computed(() => Boolean(client.system))
  const running = computed(() => toValue(enabled) && visibility.value === "visible" && available.value)
  const snapshot = ref<SystemStatus>()
  const history = ref<SystemStatus[]>([])
  const loading = ref(false)
  const error = ref<string>()
  let revision = 0
  let pending = false
  let disposed = false

  async function refresh(): Promise<void> {
    const api = client.system
    if (!api || !running.value || pending || disposed) return
    const requestRevision = revision
    pending = true
    loading.value = true
    try {
      const value = await api.status()
      if (disposed || requestRevision !== revision) return
      snapshot.value = value
      error.value = undefined
      // A cached native sample must not appear as another point in the chart.
      history.value = [...history.value.filter(sample => sample.sampledAt >= value.sampledAt - SYSTEM_STATUS_HISTORY && sample.sampledAt < value.sampledAt), value].slice(-31)
    } catch (reason) {
      if (!disposed && requestRevision === revision) error.value = reason instanceof Error ? reason.message : String(reason)
    } finally {
      pending = false
      if (!disposed) {
        loading.value = false
        // Resume promptly if visibility or the target changed during a request.
        if (requestRevision !== revision && running.value) void refresh()
      }
    }
  }

  const { pause, resume } = useIntervalFn(() => { void refresh() }, SYSTEM_STATUS_INTERVAL, { immediate: false })
  watchImmediate(() => [toValue(machineId), running.value] as const, ([id, active], previous) => {
    ++revision
    pause()
    if (id !== previous?.[0]) {
      snapshot.value = undefined
      history.value = []
      error.value = undefined
    }
    if (active) { void refresh(); resume() }
  }, { flush: "sync" })
  onScopeDispose(() => { disposed = true; ++revision; pause() })

  return { snapshot, history, loading, error, available, running, refresh }
}
