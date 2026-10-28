import { useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { computed, hasInjectionContext, onScopeDispose, ref, watch } from "vue"
import type { AgentSessionRecord } from "../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { useFleetStore } from "./fleet.ts"

export interface PinnedSession {
  machineId: string
  sessionId: string
  /** Retained on this device while another machine's history is unavailable. */
  title: string
}
export interface PinnedSessionItem extends PinnedSession {
  machineName: string
  online: boolean
  archiveState?: AgentSessionRecord["archiveState"]
  loaded: boolean
}
type Metadata = Pick<AgentSessionRecord, "title" | "archiveState">
const key = (machineId: string, sessionId: string) => JSON.stringify([machineId, sessionId])

/** Personal device preferences; central machine IDs qualify machine-local Session IDs. */
export const usePinnedSessionsStore = defineStore("pinned-sessions", () => {
  const account = hasInjectionContext() ? useAccountSession() : undefined
  const fleet = useFleetStore()
  const agents = useAgentSessionsStore()
  const scope = computed(() => {
    const user = account?.account.value.user
    return user && account?.teamId.value
      ? JSON.stringify([account.account.value.serverUrl, user.id, account.teamId.value]) : undefined
  })
  // Local fixtures and embedded demos have no account identity or shared storage.
  const saved = account
    ? useLocalStorage<Record<string, PinnedSession[]>>("deskfleet.pinned-sessions", {}, { writeDefaults: false, flush: "post" })
    : ref<Record<string, PinnedSession[]>>({})
  const pins = computed(() => account && !scope.value ? [] : saved.value[scope.value ?? "local"] ?? [])
  const metadata = ref<Record<string, Metadata>>({})
  let revision = 0
  let disposed = false
  const machines = computed(() => account ? account.machines.value : fleet.machines)

  const items = computed<PinnedSessionItem[]>(() => pins.value.flatMap(pin => {
    const machine = machines.value.find(machine => machine.id === pin.machineId)
    if (!machine) return []
    const loaded = fleet.machines.find(machine => machine.id === pin.machineId)
    const local = pin.machineId === fleet.targetId ? agents.sessions[pin.sessionId] : undefined
    const summary = loaded?.sessions.find(session => session.id === pin.sessionId)
      ?? loaded?.workspaces.flatMap(workspace => workspace.sessions).find(session => session.id === pin.sessionId)
    const remote = metadata.value[key(pin.machineId, pin.sessionId)]
    return [{ ...pin, title: local?.title ?? summary?.title ?? remote?.title ?? pin.title,
      archiveState: local?.archiveState ?? summary?.archiveState ?? remote?.archiveState,
      machineName: machine.name, online: machine.online, loaded: !!loaded }]
  }))

  function isPinned(machineId: string, sessionId: string): boolean {
    return pins.value.some(pin => pin.machineId === machineId && pin.sessionId === sessionId)
  }
  function save(values: PinnedSession[]): void {
    if (account && !scope.value) return
    saved.value = { ...saved.value, [scope.value ?? "local"]: values }
  }
  function pin(machineId: string, sessionId: string, title: string): void {
    if (account && !scope.value || !machines.value.some(machine => machine.id === machineId) || isPinned(machineId, sessionId)) return
    save([...pins.value, { machineId, sessionId, title }])
  }
  function unpin(machineId: string, sessionId: string): void {
    save(pins.value.filter(pin => pin.machineId !== machineId || pin.sessionId !== sessionId))
    delete metadata.value[key(machineId, sessionId)]
  }
  async function refresh(): Promise<void> {
    const selected = scope.value
    const current = ++revision
    if (!account || !selected) return
    await Promise.all(items.value.filter(item => !item.loaded).map(async item => {
      try {
        const { snapshot } = await account.central.session(item.machineId, item.sessionId)
        if (disposed || selected !== scope.value || current !== revision || !isPinned(item.machineId, item.sessionId)) return
        metadata.value[key(item.machineId, item.sessionId)] = { title: snapshot.session.title, archiveState: snapshot.session.archiveState }
      } catch { /* Keep the cached title when this machine's retained history is unavailable. */ }
    }))
  }

  watch(scope, () => { revision++; metadata.value = {} }, { flush: "sync" })
  watch(() => JSON.stringify([scope.value, pins.value.map(pin => key(pin.machineId, pin.sessionId)),
    machines.value.map(machine => machine.id), fleet.machines.map(machine => machine.id)]), () => { void refresh() }, { immediate: true })
  watch(items, values => {
    const titles = new Map(values.map(item => [key(item.machineId, item.sessionId), item.title]))
    if (pins.value.some(pin => titles.has(key(pin.machineId, pin.sessionId)) && titles.get(key(pin.machineId, pin.sessionId)) !== pin.title)) {
      save(pins.value.map(pin => ({ ...pin, title: titles.get(key(pin.machineId, pin.sessionId)) ?? pin.title })))
    }
  })
  const unsubscribe = account?.central.onEvent(event => {
    if (event.type === "connection" && event.connected
      || event.type === "catalogChanged" && pins.value.some(pin => pin.machineId === event.machineId && (!event.sessionId || pin.sessionId === event.sessionId))) {
      void refresh()
    }
  })
  onScopeDispose(() => { disposed = true; revision++; unsubscribe?.() })
  return { pins, items, isPinned, pin, unpin, refresh }
})
