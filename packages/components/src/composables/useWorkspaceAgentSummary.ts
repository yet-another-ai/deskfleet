import { useDocumentVisibility } from "@vueuse/core"
import { defineStore } from "pinia"
import { inject, markRaw, onScopeDispose, shallowReactive, watch, type ComputedRef, type InjectionKey } from "vue"
import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi, SuperAgentApi } from "@deskfleet/client/desktop-api"
import { remoteMachineClient } from "@deskfleet/client/remote"
import {
  computeSaSummaryFromSnapshot,
  isSaSummaryUnread,
  mergeSaMarkerRef,
  type SaVisibleMarkerRef,
  type SuperMachineSummary,
  type SuperSnapshot,
  type SuperWorkspaceId,
  type SuperWorkspaceSummary,
} from "@deskfleet/protocol/super-agent"
import { createWorkspaceAgentClient } from "../services/workspace-agent-client.ts"
import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import {
  isDelegatedWorkerResultRepresented,
  summarizeUnopenedCentralSession,
  workspaceSummaryKey,
  type MachineSaSummaryRecord,
  type WorkspaceSaViewState,
} from "../services/workspace-agent-sidebar.ts"
import type { AccountSession } from "./useAccountSession.ts"

const STORAGE_KEY = "deskfleet.workspace-agent.unread"
const SUMMARY_POLL_MS = 15_000

interface PersistedWorkspaceUnread {
  latestVisible?: SaVisibleMarkerRef
  lastRead?: SaVisibleMarkerRef
  activeErrorKeys?: string[]
  readErrorKeys?: string[]
  delegatedCompletedSeqs?: Record<string, string>
}

interface UnreadScopeIdentity {
  serverUrl?: string
  userId?: string
  teamId?: string
}

function readPersistedStore(): Record<string, PersistedWorkspaceUnread> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, PersistedWorkspaceUnread>
      : {}
  } catch {
    return {}
  }
}

function writePersistedStore(records: Record<string, PersistedWorkspaceUnread>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    // Storage quota or unavailable storage must not break UI rendering.
  }
}

export function workspaceUnreadStorageKey(
  identity: UnreadScopeIdentity,
  machineId: string,
  workspaceId: SuperWorkspaceId,
): string {
  return JSON.stringify([identity.serverUrl ?? "", identity.userId ?? "", identity.teamId ?? "", machineId, workspaceId])
}

function mergeErrorKeys(a?: readonly string[], b?: readonly string[]): string[] | undefined {
  const merged = new Set([...(a ?? []), ...(b ?? [])])
  return merged.size ? [...merged].slice(-200) : undefined
}

function mergeDelegatedSeqs(
  a?: Readonly<Record<string, string>>,
  b?: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(a ?? {}) }
  for (const [sessionId, seq] of Object.entries(b ?? {})) {
    const existing = merged[sessionId]
    try {
      if (!existing || BigInt(seq) > BigInt(existing)) merged[sessionId] = seq
    } catch {
      merged[sessionId] = seq
    }
  }
  return merged
}

function toViewState(
  ws: SuperWorkspaceSummary,
  persisted: PersistedWorkspaceUnread | undefined,
): { view: WorkspaceSaViewState; nextPersisted: PersistedWorkspaceUnread } {
  const latestVisible = ws.latestVisible
  const lastRead = mergeSaMarkerRef(persisted?.lastRead, ws.lastRead)
  const readErrorKeys = mergeErrorKeys(persisted?.readErrorKeys, ws.readErrorKeys)
  const delegatedCompletedSeqs = mergeDelegatedSeqs(persisted?.delegatedCompletedSeqs, ws.delegatedCompletedSeqs)
  const unread = isSaSummaryUnread(latestVisible, lastRead, ws.activeErrorKeys, readErrorKeys)
  return {
    view: {
      workspaceId: ws.workspaceId,
      ...(latestVisible ? { latestVisible } : {}),
      ...(lastRead ? { lastRead } : {}),
      unread,
      working: ws.working,
      saActive: ws.saActive,
      activeDelegatedSessionIds: [...ws.activeDelegatedSessionIds],
      delegatedCompletedSeqs,
    },
    nextPersisted: {
      ...(latestVisible ? { latestVisible } : {}),
      ...(lastRead ? { lastRead } : {}),
      ...(ws.activeErrorKeys?.length ? { activeErrorKeys: [...ws.activeErrorKeys] } : {}),
      ...(readErrorKeys?.length ? { readErrorKeys } : {}),
      ...(Object.keys(delegatedCompletedSeqs).length ? { delegatedCompletedSeqs } : {}),
    },
  }
}

export interface ObserveMachineOptions {
  online: boolean
  unopened: boolean
  api?: SuperAgentApi
  machine?: Machine
  catalogOnChanged?: (listener: (sessionId?: string) => void) => () => void
}

export interface WorkspaceAgentSummaryStore {
  machineState(machineId: string): MachineSaSummaryRecord | undefined
  isDelegatedWorkerSuperseded(machineId: string, sessionId: string, lastCompletedSeq?: string): boolean
  observeSnapshot(machineId: string, snapshot: SuperSnapshot): void
  markVisibleSeen(
    machineId: string,
    workspaceId: SuperWorkspaceId,
    marker: SaVisibleMarkerRef,
    errorKeys?: readonly string[],
    api?: SuperAgentApi,
  ): Promise<void>
  refreshMachine(machineId: string, opts: ObserveMachineOptions): Promise<void>
  observeMachine(machineId: () => string, getOpts: () => ObserveMachineOptions): () => void
  resetScope(): void
  dispose(): void
}

export const workspaceAgentSummaryKey: InjectionKey<WorkspaceAgentSummaryStore> = Symbol("deskfleet workspace agent summary")

export function createWorkspaceAgentSummary(options: {
  host?: DeskfleetDesktopApi
  session?: AccountSession
  identity?: ComputedRef<UnreadScopeIdentity>
} = {}): WorkspaceAgentSummaryStore {
  const workspaceMode = useWorkspaceAgentMode()
  const machines = shallowReactive(new Map<string, MachineSaSummaryRecord>())
  const requestTokens = new Map<string, number>()
  const observerCleanups = new Set<() => void>()
  let disposed = false

  function currentIdentity(): UnreadScopeIdentity {
    if (options.identity) return options.identity.value
    return {
      serverUrl: options.session?.account.value.serverUrl,
      userId: options.session?.account.value.user?.id,
      teamId: options.session?.teamId.value,
    }
  }

  function identityKey(identity = currentIdentity()): string {
    return JSON.stringify([identity.serverUrl ?? "", identity.userId ?? "", identity.teamId ?? ""])
  }

  function hydratePersistedWorkspaces(machineId: string, identity = currentIdentity()): Record<string, WorkspaceSaViewState> {
    const store = readPersistedStore()
    const prefix = JSON.stringify([identity.serverUrl ?? "", identity.userId ?? "", identity.teamId ?? "", machineId]).slice(0, -1) + ","
    const hydrated: Record<string, WorkspaceSaViewState> = {}
    for (const [key, entry] of Object.entries(store)) {
      if (!key.startsWith(prefix)) continue
      try {
        const parsed = JSON.parse(key) as [string, string, string, string, SuperWorkspaceId]
        const workspaceId = parsed[4]
        const unread = isSaSummaryUnread(entry.latestVisible, entry.lastRead, entry.activeErrorKeys, entry.readErrorKeys)
        hydrated[workspaceSummaryKey(workspaceId)] = {
          workspaceId,
          ...(entry.latestVisible ? { latestVisible: entry.latestVisible } : {}),
          ...(entry.lastRead ? { lastRead: entry.lastRead } : {}),
          unread,
          working: false,
          saActive: false,
          activeDelegatedSessionIds: [],
          delegatedCompletedSeqs: entry.delegatedCompletedSeqs ? { ...entry.delegatedCompletedSeqs } : {},
        }
      } catch { /* ignore malformed entry */ }
    }
    return hydrated
  }

  function ensureRecord(machineId: string): MachineSaSummaryRecord {
    const existing = machines.get(machineId)
    if (existing) return existing
    const record: MachineSaSummaryRecord = {
      status: "unknown",
      workspaces: hydratePersistedWorkspaces(machineId),
    }
    machines.set(machineId, record)
    return record
  }

  function applyWorkspaceSummary(
    machineId: string,
    summary: SuperWorkspaceSummary,
    identity = currentIdentity(),
  ): WorkspaceSaViewState {
    const store = readPersistedStore()
    const storageKey = workspaceUnreadStorageKey(identity, machineId, summary.workspaceId)
    const { view, nextPersisted } = toViewState(summary, store[storageKey])
    store[storageKey] = nextPersisted
    writePersistedStore(store)

    const existing = ensureRecord(machineId)
    machines.set(machineId, {
      ...existing,
      workspaces: {
        ...existing.workspaces,
        [workspaceSummaryKey(summary.workspaceId)]: view,
      },
    })
    return view
  }

  function applyMachineSummary(
    machineId: string,
    summary: SuperMachineSummary,
    unopenedSessions?: MachineSaSummaryRecord["unopenedSessions"],
    identity = currentIdentity(),
  ): void {
    const store = readPersistedStore()
    const nextWorkspaces: Record<string, WorkspaceSaViewState> = {}
    for (const ws of summary.workspaces) {
      const storageKey = workspaceUnreadStorageKey(identity, machineId, ws.workspaceId)
      const { view, nextPersisted } = toViewState(ws, store[storageKey])
      store[storageKey] = nextPersisted
      nextWorkspaces[workspaceSummaryKey(ws.workspaceId)] = view
    }
    writePersistedStore(store)
    const previous = machines.get(machineId)
    machines.set(machineId, {
      status: "ready",
      workspaces: nextWorkspaces,
      privateWorkspaceId: summary.privateWorkspaceId ?? previous?.privateWorkspaceId,
      ...(unopenedSessions !== undefined ? { unopenedSessions } : previous?.unopenedSessions ? { unopenedSessions: previous.unopenedSessions } : {}),
      loadedAt: Date.now(),
    })
  }

  function observeSnapshot(machineId: string, snapshot: SuperSnapshot): void {
    if (disposed || !machineId) return
    const summary = computeSaSummaryFromSnapshot(snapshot)
    applyWorkspaceSummary(machineId, summary)
  }

  async function markVisibleSeen(
    machineId: string,
    workspaceId: SuperWorkspaceId,
    marker: SaVisibleMarkerRef,
    errorKeys: readonly string[] = [],
    api?: SuperAgentApi,
  ): Promise<void> {
    if (disposed || !machineId) return
    const identity = currentIdentity()
    const store = readPersistedStore()
    const storageKey = workspaceUnreadStorageKey(identity, machineId, workspaceId)
    const prev = store[storageKey] ?? {}
    const nextLastRead = mergeSaMarkerRef(prev.lastRead, marker)
    const nextReadErrors = mergeErrorKeys(prev.readErrorKeys, errorKeys)
    const markerAdvanced = !prev.lastRead
      || (nextLastRead !== undefined && (nextLastRead.order > prev.lastRead.order || nextLastRead.key !== prev.lastRead.key))
    const errorsAdvanced = (nextReadErrors?.length ?? 0) > (prev.readErrorKeys?.length ?? 0)

    store[storageKey] = {
      ...prev,
      ...(nextLastRead ? { lastRead: nextLastRead } : {}),
      ...(nextReadErrors?.length ? { readErrorKeys: nextReadErrors } : {}),
    }
    writePersistedStore(store)

    const existing = ensureRecord(machineId)
    const wsKey = workspaceSummaryKey(workspaceId)
    const wsPrev = existing.workspaces[wsKey]
    const latestVisible = wsPrev?.latestVisible ?? prev.latestVisible
    const nextView: WorkspaceSaViewState = wsPrev
      ? {
          ...wsPrev,
          ...(nextLastRead ? { lastRead: nextLastRead } : {}),
          unread: isSaSummaryUnread(latestVisible, nextLastRead, prev.activeErrorKeys, nextReadErrors),
        }
      : {
          workspaceId,
          ...(latestVisible ? { latestVisible } : {}),
          ...(nextLastRead ? { lastRead: nextLastRead } : {}),
          unread: isSaSummaryUnread(latestVisible, nextLastRead, prev.activeErrorKeys, nextReadErrors),
          working: false,
          saActive: false,
          activeDelegatedSessionIds: [],
          delegatedCompletedSeqs: prev.delegatedCompletedSeqs ? { ...prev.delegatedCompletedSeqs } : {},
        }

    machines.set(machineId, {
      ...existing,
      workspaces: {
        ...existing.workspaces,
        [wsKey]: nextView,
      },
    })

    if ((markerAdvanced || errorsAdvanced) && api?.markRead && nextLastRead) {
      const scopeSnapshot = identityKey(identity)
      try {
        const updated = await api.markRead({
          workspaceId,
          key: nextLastRead.key,
          order: nextLastRead.order,
          messageId: nextLastRead.messageId,
          ...(errorKeys.length ? { errorKeys: [...errorKeys] } : {}),
        })
        if (!disposed && identityKey() === scopeSnapshot) {
          applyWorkspaceSummary(machineId, updated, identity)
        }
      } catch {
        // Local persistence retains the seen watermark even if offline or older host lacks markRead.
      }
    }
  }

  async function refreshMachine(machineId: string, opts: ObserveMachineOptions): Promise<void> {
    if (disposed || !workspaceMode.value) return
    const identity = currentIdentity()
    const scopeKey = identityKey(identity)
    const existing = ensureRecord(machineId)

    if (!opts.online) {
      // Explicit offline: never poll; clear active working states while preserving persisted unread!
      const offlineWorkspaces: Record<string, WorkspaceSaViewState> = {}
      for (const [k, ws] of Object.entries(existing.workspaces)) {
        offlineWorkspaces[k] = { ...ws, working: false, saActive: false }
      }
      machines.set(machineId, {
        ...existing,
        workspaces: offlineWorkspaces,
      })
      return
    }

    const token = (requestTokens.get(machineId) ?? 0) + 1
    requestTokens.set(machineId, token)
    const isCurrent = () => !disposed && workspaceMode.value && identityKey() === scopeKey && requestTokens.get(machineId) === token

    if (!opts.unopened) {
      if (!opts.api?.summary) {
        if (isCurrent() && existing.status === "unknown") {
          machines.set(machineId, { ...existing, status: "ready", loadedAt: Date.now() })
        }
        return
      }
      try {
        const summary = await opts.api.summary({})
        if (!isCurrent()) return
        applyMachineSummary(machineId, summary, undefined, identity)
      } catch {
        if (!isCurrent()) return
        const current = ensureRecord(machineId)
        if (current.status === "unknown") {
          machines.set(machineId, { ...current, status: "error" })
        }
      }
      return
    }

    // Unopened machine: fetch ONLY lightweight session metadata + lightweight SA summary (never full conversations).
    const session = options.session
    const host = options.host
    const machine = opts.machine ?? session?.machines.value.find(item => item.id === machineId)
    if (!session || !machine) return

    let unopenedSessions: MachineSaSummaryRecord["unopenedSessions"]
    let saSummary: SuperMachineSummary | undefined
    let sessionsOk = false
    let saOk = false

    const sessionsPromise = session.central.sessions(machine.teamId, machine.id)
      .then(list => {
        sessionsOk = true
        unopenedSessions = list.map(summarizeUnopenedCentralSession)
      })
      .catch(() => { /* preserve unknown if failed */ })

    const enrollment = session.enrollment.value
    const isLocal = !!host && host.platform !== "web"
      && session.localMachineId.value === machine.id
      && enrollment?.teamId === machine.teamId
    const canQuerySa = !!host && (
      isLocal ? !!host.localChannels : (machine.capabilities?.superAgent === true && (host.platform !== "web" || host.remoteWorkspaceAgent === true))
    )

    const saPromise = canQuerySa
      ? (async () => {
          const remote = remoteMachineClient(host!, session.central, machine, { local: isLocal, rosterReady: true })
          const frontDesk = createWorkspaceAgentClient(remote.api.agent, () => true)
          try {
            if (frontDesk.api.summary) {
              saSummary = await frontDesk.api.summary({})
              saOk = true
            }
          } catch {
            // Host may not yet support summary RPC or transient failure.
          } finally {
            frontDesk.close()
            remote.dispose()
          }
        })()
      : Promise.resolve().then(() => { saOk = true })

    await Promise.all([sessionsPromise, saPromise])
    if (!isCurrent()) return

    if (saSummary) {
      applyMachineSummary(machineId, saSummary, unopenedSessions, identity)
    } else if (sessionsOk && saOk) {
      const current = ensureRecord(machineId)
      machines.set(machineId, {
        ...current,
        status: "ready",
        ...(unopenedSessions !== undefined ? { unopenedSessions } : {}),
        loadedAt: Date.now(),
      })
    } else if (existing.status === "unknown") {
      machines.set(machineId, { ...existing, status: "error" })
    }
  }

  function observeMachine(machineId: () => string, getOpts: () => ObserveMachineOptions): () => void {
    const visible = useDocumentVisibility()
    let timer: ReturnType<typeof setInterval> | undefined
    let stopCentral: (() => void) | undefined
    let stopCatalog: (() => void) | undefined
    let stopped = false

    const clearTimersAndEvents = () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      stopCentral?.()
      stopCentral = undefined
      stopCatalog?.()
      stopCatalog = undefined
    }

    const triggerRefresh = () => {
      if (stopped || disposed || !workspaceMode.value) return
      const id = machineId()
      const opts = getOpts()
      if (!id) return
      void refreshMachine(id, opts)
    }

    const stopWatch = watch(
      () => {
        // Strict classic-mode boundary: do not subscribe to SA summary transport when SA mode is off.
        if (!workspaceMode.value) return [false, "", false, false, false, ""] as const
        const id = machineId()
        const opts = getOpts()
        return [true, id, opts.online, opts.unopened, visible.value !== "hidden", identityKey()] as const
      },
      ([enabled, id, online, _unopened, isVisible]) => {
        clearTimersAndEvents()
        if (!enabled || !id) return
        // Apply offline pause immediately or refresh immediately on online/mount/reconnect.
        triggerRefresh()
        if (!online || !isVisible) return

        if (options.session?.central) {
          stopCentral = options.session.central.onEvent(event => {
            if (!workspaceMode.value) return
            if (event.type === "catalogChanged" && event.machineId === id) triggerRefresh()
            else if (event.type === "presence" && event.machineId === id) triggerRefresh()
          })
        }
        const opts = getOpts()
        if (opts.catalogOnChanged) {
          stopCatalog = opts.catalogOnChanged(() => triggerRefresh())
        }
        timer = setInterval(() => {
          if (workspaceMode.value && getOpts().online && visible.value !== "hidden") {
            triggerRefresh()
          }
        }, SUMMARY_POLL_MS)
      },
      { immediate: true },
    )

    const cleanup = () => {
      if (stopped) return
      stopped = true
      stopWatch()
      clearTimersAndEvents()
      observerCleanups.delete(cleanup)
    }
    observerCleanups.add(cleanup)
    return cleanup
  }

  function machineState(machineId: string): MachineSaSummaryRecord | undefined {
    if (!workspaceMode.value) return undefined
    const existing = machines.get(machineId)
    if (existing) return existing
    const hydrated = hydratePersistedWorkspaces(machineId)
    if (Object.keys(hydrated).length) {
      const record: MachineSaSummaryRecord = { status: "unknown", workspaces: hydrated }
      machines.set(machineId, record)
      return record
    }
    return undefined
  }

  function isDelegatedWorkerSuperseded(machineId: string, sessionId: string, lastCompletedSeq?: string): boolean {
    if (!workspaceMode.value || !lastCompletedSeq) return false
    const record = machineState(machineId)
    if (!record) return false
    for (const ws of Object.values(record.workspaces)) {
      if (isDelegatedWorkerResultRepresented({ id: sessionId, lastCompletedSeq }, ws.delegatedCompletedSeqs)) {
        return true
      }
    }
    return false
  }

  function resetScope(): void {
    requestTokens.clear()
    machines.clear()
  }

  function dispose(): void {
    disposed = true
    for (const cleanup of [...observerCleanups]) cleanup()
    observerCleanups.clear()
    requestTokens.clear()
    machines.clear()
  }

  onScopeDispose(dispose)

  return {
    machineState,
    isDelegatedWorkerSuperseded,
    observeSnapshot,
    markVisibleSeen,
    refreshMachine,
    observeMachine,
    resetScope,
    dispose,
  }
}

const useFallbackWorkspaceAgentSummaryStore = defineStore("workspace-agent-summary", () => ({
  summary: markRaw(createWorkspaceAgentSummary()),
}))

/** Shared SA summary store across host sidebar, mounted machine surfaces, and workspace views. */
export function useWorkspaceAgentSummary(): WorkspaceAgentSummaryStore {
  return inject(workspaceAgentSummaryKey, undefined) ?? useFallbackWorkspaceAgentSummaryStore().summary
}
