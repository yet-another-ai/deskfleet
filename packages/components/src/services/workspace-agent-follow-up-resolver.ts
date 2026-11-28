import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi, SuperAgentApi } from "@deskfleet/client/desktop-api"
import { remoteMachineClient } from "@deskfleet/client/remote"
import type { AccountSession } from "../composables/useAccountSession.ts"
import type { MachineRuntimes } from "../composables/useMachineRuntimes.ts"
import { createWorkspaceAgentClient } from "./workspace-agent-client.ts"
import type { FollowUpApiHandle, FollowUpApiResolver, FollowUpScope } from "./workspace-agent-follow-up.ts"

/**
 * Resolve a SuperAgentApi handle for ANY `(teamId, machineId)` belonging to the signed-in user:
 * 1. Reuse an already-opened MachineRuntime if its team matches.
 * 2. Otherwise discover the Machine across any team via `central.machines(teamId)` and open a
 *    lightweight transient client that is disposed immediately after the revocation call completes.
 * 3. Return `undefined` when a remote machine is offline or incompatible so pending revocations
 *    stay durably queued until it reconnects.
 */
export function createFollowUpMachineResolver(options: {
  host?: DeskfleetDesktopApi
  session?: AccountSession
  runtimes?: MachineRuntimes
  fallback?: { machineId?: string; teamId?: string; api?: SuperAgentApi }
}): FollowUpApiResolver {
  const teamRosters = new Map<string, Promise<Machine[]>>()
  const loadTeamMachines = (teamId: string): Promise<Machine[]> => {
    if (options.session && options.session.teamId.value === teamId && options.session.machines.value.length) {
      return Promise.resolve(options.session.machines.value)
    }
    const existing = teamRosters.get(teamId)
    if (existing) return existing
    const pending = options.session?.central.machines(teamId).catch(() => []) ?? Promise.resolve([])
    teamRosters.set(teamId, pending)
    return pending
  }

  return async (scope: FollowUpScope): Promise<FollowUpApiHandle | undefined> => {
    const machineId = scope.machineId
    const teamId = scope.teamId

    // 1. Reuse already-opened runtime if matching machine + team
    if (machineId && options.runtimes) {
      const opened = options.runtimes.opened.get(machineId)
      if (opened?.api.superAgent && (!teamId || opened.api.target?.teamId === teamId)) {
        return { api: opened.api.superAgent }
      }
    }

    // 2. Standalone fallback (e.g. component mounted directly without AccountShell/MachineRuntimes)
    if (options.fallback?.api && (!machineId || machineId === options.fallback.machineId) && (!teamId || !options.fallback.teamId || teamId === options.fallback.teamId)) {
      return { api: options.fallback.api }
    }

    // 3. Discover unopened machine across any Team via central roster and connect transiently
    if (!options.host || !options.session || !teamId || !machineId) return undefined
    const roster = await loadTeamMachines(teamId)
    const machine = roster.find(item => item.id === machineId && item.teamId === teamId)
    if (!machine) return undefined

    const enrollment = options.session.enrollment.value
    const isLocal = options.host.platform !== "web"
      && options.session.localMachineId.value === machine.id
      && enrollment?.teamId === machine.teamId

    if (!isLocal && (!machine.online || machine.capabilities?.superAgent !== true)) {
      return undefined
    }
    if (isLocal && !options.host.localChannels) {
      return undefined
    }

    const remote = remoteMachineClient(options.host, options.session.central, machine, { local: isLocal, rosterReady: true })
    const frontDesk = createWorkspaceAgentClient(remote.api.agent, () => true)
    return {
      api: frontDesk.api,
      dispose: () => {
        frontDesk.close()
        remote.dispose()
      },
    }
  }
}
