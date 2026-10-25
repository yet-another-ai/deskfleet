import { useDocumentVisibility, useTimeoutFn, watchImmediate, whenever } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue"
import type { GitDiffRequest, GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"

const REFRESH_MS = 1_500
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
  let pending: Promise<void> | undefined
  let pendingDiff: { request: GitDiffRequest; promise: Promise<void> } | undefined
  const { start: scheduleRefresh, stop: clearTimer } = useTimeoutFn(() => { void refresh() }, REFRESH_MS, { immediate: false })
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

  function readDiff(): Promise<void> {
    const request = selection.value
    if (!request || !active()) return Promise.resolve()
    if (pendingDiff?.request === request) return pendingDiff.promise
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

  function refresh(): Promise<void> {
    if (!active()) return Promise.resolve()
    if (pending) return pending
    clearTimer()
    const current = generation
    const id = toValue(sessionId)
    loading.value = !snapshot.value
    const request = (async () => {
      try {
        const result = await agents.gitStatus(id)
        if (disposed || current !== generation) return
        snapshot.value = result
        error.value = null
        const selected = selection.value
        if (selected) {
          const repository = result.repositories.find(value => value.id === selected.repositoryId)
          if (repository && !repository.error && !repository.changes.some(change => change.path === selected.path && change.kind === selected.kind)) closeDiff()
          else await readDiff()
        }
      } catch (reason) {
        if (!disposed && current === generation) error.value = message(reason)
      } finally {
        if (!disposed && current === generation) {
          loading.value = false
          pending = undefined
          if (active()) scheduleRefresh()
        }
      }
    })()
    pending = request
    return request
  }

  watchImmediate([() => toValue(sessionId), () => toValue(enabled)], () => {
    generation++
    pending = undefined
    clearTimer()
    closeDiff()
    snapshot.value = null
    error.value = null
    loading.value = false
    void refresh()
  })
  whenever(connected, () => { void refresh() })
  watch(visibility, () => {
    clearTimer()
    if (active()) void refresh()
  })
  onScopeDispose(() => {
    disposed = true
    generation++
    closeDiff()
    clearTimer()
  })
  return { snapshot, loading, error, connected, selection, diff, diffLoading, diffError, refresh, select, closeDiff }
}
