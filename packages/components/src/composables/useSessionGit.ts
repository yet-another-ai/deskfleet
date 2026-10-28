import { useDebounceFn, useDocumentVisibility, watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue"
import type { GitChangeKind, GitDiffRequest, GitFileChange, GitStatusSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"
import { gitDiffCardKey, type GitDiffCard } from "../components/details/git-diff-card.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

export { gitDiffCardKey, type GitDiffCard }

/** Inspect only the visible Session context; filesystem changes need no agent events. */
export function useSessionGit(sessionId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const agents = useAgentSessionsStore()
  const snapshot = shallowRef<GitStatusSnapshot | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const connected = computed(() => agents.state === "connected")
  const cards = shallowRef<ReadonlyMap<string, GitDiffCard>>(new Map())
  let generation = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let attaching: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let dirty = false
  let forceNext = false
  let watchError: string | null = null
  const cardGeneration = new Map<string, number>()
  const pendingCards = new Map<string, { request: GitDiffRequest; promise: Promise<void> }>()
  const scheduleRefresh = useDebounceFn(() => {
    if (!attaching) return readStatus()
  }, 300, { maxWait: 2_000 })
  const visibility = useDocumentVisibility()

  function active(): boolean { return !disposed && toValue(enabled) && !!toValue(sessionId) && visibility.value !== "hidden" }
  function writeCards(next: ReadonlyMap<string, GitDiffCard>): void { cards.value = next }
  function putCard(key: string, card: GitDiffCard): void {
    const next = new Map(cards.value)
    next.set(key, card)
    writeCards(next)
  }
  function dropCard(key: string): void {
    cardGeneration.set(key, (cardGeneration.get(key) ?? 0) + 1)
    pendingCards.delete(key)
    if (!cards.value.has(key)) return
    const next = new Map(cards.value)
    next.delete(key)
    writeCards(next)
  }
  function clearCards(): void {
    for (const key of cards.value.keys()) cardGeneration.set(key, (cardGeneration.get(key) ?? 0) + 1)
    pendingCards.clear()
    writeCards(new Map())
  }

  /** One generation per open card, so a late response cannot fill a card that was collapsed or replaced. */
  function readCard(key: string, fresh = false): Promise<void> {
    const card = cards.value.get(key)
    if (!card || !active()) return Promise.resolve()
    const request = card.request
    const inflight = pendingCards.get(key)
    if (inflight?.request === request) {
      const statusGeneration = generation
      const seen = cardGeneration.get(key)
      return fresh ? inflight.promise.then(() => {
        if (statusGeneration === generation && cards.value.get(key)?.request === request && cardGeneration.get(key) === seen && active()) return readCard(key)
      }) : inflight.promise
    }
    const token = (cardGeneration.get(key) ?? 0) + 1
    cardGeneration.set(key, token)
    const current = cards.value.get(key)
    if (current && !current.diff) putCard(key, { ...current, loading: true })
    const promise = (async () => {
      try {
        const result = await agents.gitDiff(request)
        if (disposed || cardGeneration.get(key) !== token) return
        const latest = cards.value.get(key)
        if (!latest) return
        putCard(key, { ...latest, diff: result, loading: false, error: null })
      } catch (reason) {
        if (disposed || cardGeneration.get(key) !== token) return
        const latest = cards.value.get(key)
        if (!latest) return
        putCard(key, { ...latest, loading: false, error: message(reason) })
      } finally {
        if (!disposed && cardGeneration.get(key) === token) pendingCards.delete(key)
      }
    })()
    pendingCards.set(key, { request, promise })
    return promise
  }

  function expand(repositoryId: string, change: GitFileChange): void {
    const key = gitDiffCardKey(repositoryId, change.path, change.kind)
    if (cards.value.has(key)) return
    const request: GitDiffRequest = { sessionId: toValue(sessionId), repositoryId, path: change.path, kind: change.kind }
    putCard(key, { request, diff: null, loading: true, error: null })
    void readCard(key)
  }

  function collapse(repositoryId: string, path: string, kind: GitChangeKind): void {
    dropCard(gitDiffCardKey(repositoryId, path, kind))
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
        for (const card of [...cards.value.values()]) {
          const repository = result.repositories.find(value => value.id === card.request.repositoryId)
          const key = gitDiffCardKey(card.request.repositoryId, card.request.path, card.request.kind)
          if (repository && !repository.error && !repository.changes.some(change => change.path === card.request.path && change.kind === card.request.kind)) collapse(card.request.repositoryId, card.request.path, card.request.kind)
          else await readCard(key, true)
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
    for (const key of cardGeneration.keys()) cardGeneration.set(key, (cardGeneration.get(key) ?? 0) + 1)
    pendingCards.clear()
    loading.value = false
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
    clearCards()
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
    clearCards()
  })
  return { snapshot, loading, error, connected, cards, expand, collapse, refresh }
}
