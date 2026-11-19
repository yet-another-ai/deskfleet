import type { CentralApi } from "@deskfleet/client/central"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import type { SystemStatus } from "@deskfleet/client/system"
import { useDocumentVisibility, useIntervalFn } from "@vueuse/core"
import { defineStore } from "pinia"
import { computed, hasInjectionContext, inject, onScopeDispose, ref, shallowRef, watch, type InjectionKey } from "vue"
import { useAccountSession, type AccountSession } from "../composables/useAccountSession.ts"

export const MACHINE_BATTERY_INTERVAL = 60_000
/** Machine presence rarely changes after startup, so a missing battery is not re-read every minute. */
export const MACHINE_BATTERY_MISSING_INTERVAL = 5 * 60_000

type BatteryStatus = NonNullable<SystemStatus["battery"]>
interface BatteryEntry { battery: BatteryStatus | null; checkedAt: number }

export interface MachineBatteriesStore {
  attachAccount(account: AccountSession): void
  observe(machineId: string): () => void
  forMachine(machineId: string): BatteryStatus | undefined
  refresh(force?: boolean): Promise<void>
}

const entryKey = (teamId: string, machineId: string) => JSON.stringify([teamId, machineId])

/**
 * Background battery readings for sidebar machine rows.
 *
 * Battery has no presence channel, so this reuses `systemStatus` at a slow
 * cadence. Only online machines with a mounted indicator are requested, hidden
 * documents pause, and machines that already reported no battery wait longer
 * before another read. Battery is best-effort: failures leave the last value.
 */
export const useMachineBatteriesStore = defineStore("machine-batteries", () => {
  const account = shallowRef<AccountSession>()
  const automatic = shallowRef<CentralApi>()
  const visibility = useDocumentVisibility()

  /** The account shell provides its session after setup, so it attaches explicitly. */
  function attachAccount(next: AccountSession): void {
    account.value = next
    automatic.value = next.central && typeof next.central.rpc === "function"
      ? withCentralRequestTrigger(next.central, "background")
      : undefined
  }
  const initialAccount = hasInjectionContext() ? useAccountSession() : undefined
  if (initialAccount) attachAccount(initialAccount)
  const observed = ref(new Map<string, number>())
  const entries = shallowRef<Record<string, BatteryEntry>>({})
  const pending = new Map<string, Promise<void>>()
  let generation = 0
  let disposed = false

  const scope = computed(() => {
    const user = account.value?.account?.value.user
    const teamId = account.value?.teamId?.value
    return user && teamId
      ? JSON.stringify([account.value!.account.value.serverUrl, user.id, teamId])
      : undefined
  })
  const online = computed(() => {
    const teamId = account.value?.teamId?.value
    return new Set(teamId ? (account.value?.machines?.value ?? [])
      .filter(machine => machine.teamId === teamId && machine.online)
      .map(machine => machine.id) : [])
  })
  const active = computed(() => !!scope.value && visibility.value !== "hidden" && observed.value.size > 0)

  function forMachine(machineId: string): BatteryStatus | undefined {
    const teamId = account.value?.teamId?.value
    return teamId ? entries.value[entryKey(teamId, machineId)]?.battery ?? undefined : undefined
  }

  function observe(machineId: string): () => void {
    const next = new Map(observed.value)
    next.set(machineId, (next.get(machineId) ?? 0) + 1)
    observed.value = next
    return () => {
      const current = observed.value.get(machineId)
      if (current === undefined) return
      const remaining = new Map(observed.value)
      if (current > 1) remaining.set(machineId, current - 1)
      else remaining.delete(machineId)
      observed.value = remaining
    }
  }

  function read(teamId: string, machineId: string, current: number, force: boolean): Promise<void> {
    const key = entryKey(teamId, machineId)
    const existing = pending.get(key)
    if (existing) return existing
    const entry = entries.value[key]
    const ttl = entry?.battery ? MACHINE_BATTERY_INTERVAL / 2 : MACHINE_BATTERY_MISSING_INTERVAL
    if (!force && entry && Date.now() - entry.checkedAt < ttl) return Promise.resolve()
    const request = automatic.value!.rpc<SystemStatus>(teamId, machineId, "systemStatus", {}).then(status => {
      if (current !== generation || disposed || account.value?.teamId?.value !== teamId || !observed.value.has(machineId)) return
      entries.value = {
        ...entries.value,
        [key]: { battery: status.battery ?? null, checkedAt: Date.now() },
      }
    }).catch(() => {
      // Keep the last known value; the next interval retries.
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
    pending.set(key, request)
    return request
  }

  async function refresh(force = false): Promise<void> {
    const teamId = account.value?.teamId?.value
    if (!automatic.value || !account.value || !active.value || !teamId) return
    const current = generation
    const targets = [...observed.value.keys()].filter(machineId => online.value.has(machineId))
    await Promise.all(targets.map(machineId => read(teamId, machineId, current, force)))
  }

  watch(scope, () => {
    generation++
    entries.value = {}
    pending.clear()
    void refresh(true)
  }, { flush: "sync" })
  watch(
    () => JSON.stringify([scope.value, [...observed.value.keys()].sort(), [...online.value].sort()]),
    () => { void refresh(false) },
    { immediate: true },
  )
  watch(visibility, value => { if (value !== "hidden") void refresh() })
  const interval = useIntervalFn(() => { void refresh() }, MACHINE_BATTERY_INTERVAL, { immediate: false })
  watch(active, value => {
    if (value) { interval.resume(); void refresh() }
    else interval.pause()
  }, { immediate: true })
  onScopeDispose(() => { disposed = true; generation++; interval.pause() })

  return { attachAccount, observe, forMachine, refresh }
})

/** One cache and poller shared by the account shell and every isolated machine app. */
export const machineBatteriesKey: InjectionKey<MachineBatteriesStore> =
  Symbol("deskfleet machine batteries")

export function useMachineBatteries(): MachineBatteriesStore {
  return inject(machineBatteriesKey, undefined) ?? useMachineBatteriesStore()
}
