import { useDocumentVisibility, useEventBus, useIntervalFn, useWindowFocus } from "@vueuse/core"
import { defineStore } from "pinia"
import { computed, hasInjectionContext, onScopeDispose, ref, shallowRef, watch } from "vue"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"
import type { GithubAppSettings, GithubPullRequest } from "@deskfleet/client/central"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { githubSettingsChanged } from "../services/github-settings-events.ts"
import { useFleetStore } from "./fleet.ts"

type Branch = NonNullable<CatalogSnapshot["githubBranches"]>[number]["repositories"][number]
type Session = { machineId: string; sessionId: string; count: number }
const sessionKey = (machineId: string, sessionId: string) => JSON.stringify([machineId, sessionId])
const branchKey = (branch: Branch) => JSON.stringify([branch.repository, branch.headRepository, branch.branch])
const refreshInterval = 60_000

/** Git identity comes from the machine catalog; only GitHub status is polled. */
export const usePullRequestsStore = defineStore("pull-requests", () => {
  const account = hasInjectionContext() ? useAccountSession() : undefined
  const fleet = useFleetStore()
  const visibility = useDocumentVisibility()
  const focused = useWindowFocus()
  const sessions = ref(new Map<string, Session>())
  const catalogs = shallowRef<Record<string, CatalogSnapshot>>({})
  const settings = shallowRef<GithubAppSettings | null>(null)
  const results = shallowRef<Record<string, { pullRequest: GithubPullRequest | null; checkedAt: number }>>({})
  const scope = computed(() => {
    const user = account?.account.value.user
    return user && account?.teamId.value ? JSON.stringify([account.account.value.serverUrl, user.id, account.teamId.value]) : undefined
  })
  const active = computed(() => !!scope.value && visibility.value !== "hidden" && sessions.value.size > 0)
  const authorized = computed(() => !!settings.value?.configured && settings.value.authorized && settings.value.actAsYou)
  let generation = 0
  let disposed = false
  let settingsPending: Promise<void> | undefined
  const catalogPending = new Map<string, Promise<void>>()
  const catalogDirty = new Set<string>()
  const pullRequestPending = new Map<string, Promise<void>>()

  function branches(machineId: string, sessionId: string): Branch[] {
    if (!account?.machines.value.some(machine => machine.id === machineId)) return []
    const catalog = machineId === fleet.targetId ? fleet.catalog : catalogs.value[machineId]
    return catalog?.githubBranches?.find(session => session.sessionId === sessionId)?.repositories ?? []
  }
  const requested = computed(() => {
    const values = new Map<string, Branch>()
    for (const session of sessions.value.values()) {
      for (const branch of branches(session.machineId, session.sessionId)) values.set(branchKey(branch), branch)
    }
    return values
  })

  function forSession(machineId: string, sessionId: string): GithubPullRequest[] {
    if (!scope.value || !authorized.value) return []
    const values = new Map<string, GithubPullRequest>()
    for (const branch of branches(machineId, sessionId)) {
      const pullRequest = results.value[branchKey(branch)]?.pullRequest
      if (pullRequest) values.set(pullRequest.url, pullRequest)
    }
    return [...values.values()]
  }

  function observe(machineId: string, sessionId: string): () => void {
    const key = sessionKey(machineId, sessionId)
    const existing = sessions.value.get(key)
    if (existing) existing.count++
    else sessions.value.set(key, { machineId, sessionId, count: 1 })
    return () => {
      const current = sessions.value.get(key)
      if (current && --current.count === 0) sessions.value.delete(key)
    }
  }

  async function readSettings(force: boolean): Promise<void> {
    if (!account || !active.value || settings.value && !force) return
    if (settingsPending) return settingsPending
    const current = generation
    const request = (async () => {
      try {
        const value = await account.central.githubSettings()
        if (current === generation && !disposed) {
          settings.value = value
          if (!authorized.value) results.value = {}
        }
      } catch {
        if (current === generation && !disposed) { settings.value = null; results.value = {} }
      } finally { if (current === generation) settingsPending = undefined }
    })()
    settingsPending = request
    return request
  }

  function invalidateCatalog(machineId: string): void {
    catalogDirty.add(machineId)
    const next = { ...catalogs.value }; delete next[machineId]; catalogs.value = next
  }

  function readCatalog(machineId: string): Promise<void> {
    if (!account || machineId === fleet.targetId || !active.value || !authorized.value || catalogs.value[machineId]
      || !account.machines.value.some(machine => machine.id === machineId)) return Promise.resolve()
    const pending = catalogPending.get(machineId)
    if (pending) return pending
    const current = generation
    const request = (async () => {
      do {
        catalogDirty.delete(machineId)
        const { snapshot } = await account.central.catalog(machineId)
        if (current !== generation || disposed || !account.machines.value.some(machine => machine.id === machineId)) return
        if (!catalogDirty.has(machineId)) catalogs.value = { ...catalogs.value, [machineId]: snapshot }
      } while (catalogDirty.has(machineId) && active.value)
    })().catch(() => {
      if (current === generation && !disposed) invalidateCatalog(machineId)
    }).finally(() => { if (catalogPending.get(machineId) === request) catalogPending.delete(machineId) })
    catalogPending.set(machineId, request)
    return request
  }

  function readPullRequest(key: string, branch: Branch, force: boolean): Promise<void> {
    const pending = pullRequestPending.get(key)
    if (pending) return pending
    if (!account || !active.value || !authorized.value || !force && Date.now() - (results.value[key]?.checkedAt ?? 0) < refreshInterval) return Promise.resolve()
    const current = generation
    const [owner, repo] = branch.repository.split("/") as [string, string]
    const headOwner = branch.headRepository.split("/")[0]!
    const request = account.central.githubPullRequest({ owner, repo, branch: branch.branch, headOwner }).then(({ pullRequest }) => {
      if (current === generation && !disposed && authorized.value) results.value = { ...results.value, [key]: { pullRequest, checkedAt: Date.now() } }
    }).catch(() => {
      if (current === generation && !disposed) results.value = { ...results.value, [key]: { pullRequest: null, checkedAt: Date.now() } }
    }).finally(() => { if (pullRequestPending.get(key) === request) pullRequestPending.delete(key) })
    pullRequestPending.set(key, request)
    return request
  }

  async function refresh(force = true): Promise<void> {
    if (!active.value) return
    const current = generation
    await readSettings(force)
    if (current !== generation || !active.value || !authorized.value) return
    await Promise.all([...new Set([...sessions.value.values()].map(session => session.machineId))].map(machineId => readCatalog(machineId)))
    if (current !== generation || !active.value || !authorized.value) return
    await Promise.all([...requested.value].map(([key, branch]) => readPullRequest(key, branch, force)))
  }

  watch(scope, () => {
    generation++; settingsPending = undefined; catalogPending.clear(); catalogDirty.clear(); pullRequestPending.clear()
    settings.value = null; results.value = {}; catalogs.value = {}
  }, { flush: "sync" })
  watch(() => JSON.stringify([scope.value, account?.machines.value.map(machine => machine.id), [...sessions.value.keys()], [...requested.value.keys()]]), () => { void refresh(false) }, { immediate: true })
  const interval = useIntervalFn(() => { void refresh() }, refreshInterval, { immediate: false })
  watch(active, value => {
    if (value) { interval.resume(); void refresh() }
    else interval.pause()
  }, { immediate: true })
  watch(focused, value => { if (value) void refresh() })
  watch(() => account?.machines.value.map(machine => machine.id), machineIds => {
    for (const machineId of new Set([...Object.keys(catalogs.value), ...catalogPending.keys()])) {
      if (!machineIds?.includes(machineId)) invalidateCatalog(machineId)
    }
  })
  useEventBus(githubSettingsChanged).on(event => {
    if (event.central !== account?.central) return
    generation++; settingsPending = undefined; catalogPending.clear(); pullRequestPending.clear()
    settings.value = event.settings; results.value = {}
    void refresh(false)
  })
  const unsubscribe = account?.central.onEvent(event => {
    if (event.type === "catalogChanged") {
      invalidateCatalog(event.machineId)
      if ([...sessions.value.values()].some(session => session.machineId === event.machineId)) {
        void readCatalog(event.machineId).then(() => refresh(false))
      }
    } else if (event.type === "connection" && event.connected) {
      for (const machineId of new Set([...Object.keys(catalogs.value), ...catalogPending.keys()])) invalidateCatalog(machineId)
      void refresh()
    } else if (event.type === "accountChanged") void refresh()
  })
  onScopeDispose(() => { disposed = true; generation++; unsubscribe?.() })
  return { forSession, observe, refresh }
})
