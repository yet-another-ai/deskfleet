import { useDebounceFn, useDocumentVisibility, watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue"
import type { GitDiffRequest, GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

/** Inspect only the visible Session context; filesystem changes need no agent events. */
export function useSessionGit(sessionId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const agents = useAgentSessionsStore()
  const snapshot = shallowRef<GitStatusSnapshot | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const connected = computed(() => agents.state === "connected")
  const selection = shallowRef<GitDiffRequest | null>(null)
  const diff = shallowRef<GitFileDiff | null>(null)
  const diffLoading = ref(false)
  const diffError = ref<string | null>(null)
  let generation = 0
  let diffGeneration = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let attaching: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let dirty = false
  let forceNext = false
  let watchError: string | null = null
  let pendingDiff: { request: GitDiffRequest; promise: Promise<void> } | undefined
  const scheduleRefresh = useDebounceFn(() => {
    if (!attaching) return readStatus()
  }, 300, { maxWait: 2_000 })
  const visibility = useDocumentVisibility()

  function active(): boolean { return !disposed && toValue(enabled) && !!toValue(sessionId) && visibility.value !== "hidden" }
  function closeDiff(): void {
    diffGeneration++
    pendingDiff = undefined
    selection.value = null
    diff.value = null
    diffLoading.value = false
    diffError.value = null
  }

  function readDiff(fresh = false): Promise<void> {
    const request = selection.value
    if (!request || !active()) return Promise.resolve()
    if (pendingDiff?.request === request) {
      const current = generation
      return fresh ? pendingDiff.promise.then(() => {
        if (current === generation && selection.value === request && active()) return readDiff()
      }) : pendingDiff.promise
    }
    const current = ++diffGeneration
    diffLoading.value = !diff.value
    const promise = (async () => {
      try {
        const result = await agents.gitDiff(request)
        if (disposed || current !== diffGeneration) return
        diff.value = result
        diffError.value = null
      } catch (reason) {
        if (disposed || current !== diffGeneration) return
        diffError.value = message(reason)
      } finally {
        if (!disposed && current === diffGeneration) {
          diffLoading.value = false
          pendingDiff = undefined
        }
      }
    })()
    pendingDiff = { request, promise }
    return promise
  }

  function select(repositoryId: string, change: GitFileChange): void {
    closeDiff()
    selection.value = { sessionId: toValue(sessionId), repositoryId, path: change.path, kind: change.kind }
    void readDiff()
  }

  function readStatus(force = false): Promise<void> {
    if (!active()) return Promise.resolve()
    if (pending) {
      if (force) { dirty = true; forceNext = true }
      return pending
    }
    force ||= forceNext
    forceNext = false
    dirty = false
    const current = generation
    const id = toValue(sessionId)
    loading.value = !snapshot.value
    const request = (async () => {
      try {
        const result = await agents.gitStatus(id, force)
        if (disposed || current !== generation) return
        snapshot.value = result
        error.value = watchError
        const selected = selection.value
        if (selected) {
          const repository = result.repositories.find(value => value.id === selected.repositoryId)
          if (repository && !repository.error && !repository.changes.some(change => change.path === selected.path && change.kind === selected.kind)) closeDiff()
          else await readDiff(true)
        }
      } catch (reason) {
        if (!disposed && current === generation) error.value = message(reason)
      } finally {
        if (!disposed && current === generation) {
          loading.value = false
          pending = undefined
          if (dirty && active() && !scheduleRefresh.isPending.value) void readStatus()
        }
      }
    })()
    pending = request
    return request
  }

  function detach(): void {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    attaching = undefined
    pending = undefined
    dirty = false
    forceNext = false
    scheduleRefresh.cancel()
    diffGeneration++
    pendingDiff = undefined
    loading.value = false
    diffLoading.value = false
  }

  function attach(force = false): Promise<void> {
    if (!active()) return Promise.resolve()
    if (attaching) return attaching
    if (unsubscribe) return readStatus(force)
    const current = generation
    const id = toValue(sessionId)
    loading.value = !snapshot.value
    watchError = null
    const request = (async () => {
      try {
        const stop = await agents.watchGit(id, detail => {
          if (disposed || current !== generation || !active()) return
          watchError = detail ?? null
          if (detail) error.value = detail
          dirty = true
          void scheduleRefresh()
        })
        if (disposed || current !== generation || !active()) { stop(); return }
        unsubscribe = stop
      } catch (reason) {
        if (!disposed && current === generation) watchError = message(reason)
      } finally {
        if (!disposed && current === generation) {
          attaching = undefined
          // Install observation first so edits during the initial read are retained.
          await readStatus(force)
        }
      }
    })()
    attaching = request
    return request
  }

  async function refresh(): Promise<void> {
    scheduleRefresh.cancel()
    if (attaching) await attaching
    if (watchError) detach()
    if (!unsubscribe) await attach(true)
    else await readStatus(true)
  }

  watchImmediate([() => toValue(sessionId), () => toValue(enabled)], () => {
    detach()
    closeDiff()
    snapshot.value = null
    error.value = null
    watchError = null
    void attach()
  })
  watch(connected, value => {
    if (!value) detach()
    else if (!attaching) void attach()
  })
  watch(visibility, () => {
    detach()
    void attach()
  })
  onScopeDispose(() => {
    disposed = true
    detach()
    closeDiff()
  })
  return { snapshot, loading, error, connected, selection, diff, diffLoading, diffError, refresh, select, closeDiff }
}
