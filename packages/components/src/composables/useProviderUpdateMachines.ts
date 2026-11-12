import type { ProviderTemplateUpdates } from "@deskfleet/client/providers"
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue"
import type { AgentProviderTemplateId } from "../../../../apps/daemon/src/provider-protocol.ts"
import type { AccountSession } from "./useAccountSession.ts"
import { useAccountSession } from "./useAccountSession.ts"

export interface MachineProviderUpdates {
  id: string
  name: string
  online: boolean
  updates: ProviderTemplateUpdates
  /** Resolves once the machine has accepted the update and its state shows it. */
  upgrade(template: AgentProviderTemplateId): Promise<void>
}

interface TeamUpdatesState {
  teamId?: string
  appliedSeq: Map<string, number>
  nextSeq: number
  updates: Ref<Record<string, ProviderTemplateUpdates>>
}

const teamStates = new WeakMap<AccountSession, TeamUpdatesState>()

export function useProviderUpdateMachines(): ComputedRef<MachineProviderUpdates[]> {
  const account = useAccountSession()
  return account ? teamMachines(account) : computed(() => [])
}

/** Reads each machine's last synchronized catalog, so machines need not be opened in this window. */
function teamMachines(account: AccountSession): ComputedRef<MachineProviderUpdates[]> {
  const automatic = withCentralRequestTrigger(account.central, "background")
  const user = withCentralRequestTrigger(account.central, "user")
  let cached = teamStates.get(account)
  if (!cached) {
    cached = { appliedSeq: new Map(), nextSeq: 0, updates: ref({}) }
    teamStates.set(account, cached)
  }
  const state = cached
  const { appliedSeq, updates } = state

  async function load(teamId: string, machineId: string): Promise<void> {
    if (!appliedSeq.has(machineId)) appliedSeq.set(machineId, 0)
    const seq = ++state.nextSeq
    try {
      const { providers } = await automatic.catalog(teamId, machineId)
      if (account.teamId.value === teamId && (appliedSeq.get(machineId) ?? 0) < seq) {
        appliedSeq.set(machineId, seq)
        updates.value = { ...updates.value, [machineId]: providers?.updates ?? {} }
      }
    } catch (error) {
      // A machine that has not synchronized yet has no catalog; it reports no updates.
      console.error(`Could not read provider updates for machine ${machineId}`, error)
    }
  }

  watch(() => [account.teamId.value, account.machines.value.map(machine => machine.id).join("\n")] as const, ([teamId]) => {
    if (teamId !== state.teamId) {
      state.teamId = teamId
      appliedSeq.clear()
      updates.value = {}
    }
    if (!teamId) return
    for (const machine of account.machines.value) {
      if (!appliedSeq.has(machine.id)) void load(teamId, machine.id)
    }
  }, { immediate: true })
  onScopeDispose(account.central.onEvent(event => {
    const teamId = account.teamId.value
    if (event.type === "connection" && event.connected && teamId) {
      for (const machine of account.machines.value) void load(teamId, machine.id)
    } else if (event.type === "catalogChanged" && !event.sessionId && event.teamId === teamId) {
      void load(event.teamId, event.machineId)
    }
  }))

  return computed(() => account.machines.value.map(machine => ({
    id: machine.id,
    name: machine.name,
    online: machine.online,
    updates: updates.value[machine.id] ?? {},
    async upgrade(template) {
      const seq = ++state.nextSeq
      await user.rpc(machine.teamId, machine.id, "providerUpgrade", { template })
      if (account.teamId.value !== machine.teamId || (appliedSeq.get(machine.id) ?? 0) >= seq) return
      // The daemon publishes its updating state through the next catalog upload; show it until then.
      const current = updates.value[machine.id]?.[template]
      if (!current) return
      appliedSeq.set(machine.id, seq)
      const updating = { currentVersion: current.currentVersion, latestVersion: current.latestVersion, status: "updating" as const }
      updates.value = { ...updates.value, [machine.id]: { ...updates.value[machine.id], [template]: updating } }
    },
  })))
}
