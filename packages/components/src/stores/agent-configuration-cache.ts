import { defineStore } from "pinia"
import { toRaw, watch } from "vue"
import { cachedAgentConfiguration, type AgentConfiguration, type AgentConfigurationMatrix, type AgentConfigurationSelection } from "@deskfleet/client/agent-configuration"
import { useProvidersStore } from "./providers.ts"
import { useFleetStore } from "./fleet.ts"

interface Target { provider: string; workspaceId?: string }
interface Epoch { generation: number; directory?: string }

/** Machine runtimes own separate Pinia instances; matrices also belong to one Workspace and settings revision. */
export const useAgentConfigurationCacheStore = defineStore("agent-configuration-cache", () => {
  const providers = useProvidersStore()
  const fleet = useFleetStore()
  const matrices = new Map<string, { workspaceId?: string; matrix: AgentConfigurationMatrix }>()
  let generation = 0
  function workspaceDirectory(workspaceId?: string): string | undefined {
    return workspaceId === undefined ? undefined : fleet.catalog?.workspaces.find(workspace => workspace.id === workspaceId)
      ?.worktrees.find(worktree => worktree.sessionId === undefined)?.directories[0]?.path
  }
  const key = (target: Target) => JSON.stringify([target.provider, target.workspaceId, workspaceDirectory(target.workspaceId)])

  watch(() => providers.revision, (revision, previous) => {
    // The first registry snapshot can arrive after a configuration request starts.
    if (previous !== undefined && revision !== undefined && revision !== previous) {
      generation++
      matrices.clear()
    }
  }, { flush: "sync" })

  watch(() => fleet.catalog?.workspaces.map(workspace => [workspace.id,
    workspace.worktrees.find(worktree => worktree.sessionId === undefined)?.directories[0]?.path] as const), (directories, previous) => {
    if (!directories || !previous) return
    const current = new Map(directories)
    for (const [workspaceId, path] of previous) {
      if (path === undefined || path === current.get(workspaceId)) continue
      for (const [key, entry] of matrices) if (entry.workspaceId === workspaceId) matrices.delete(key)
    }
  }, { flush: "sync" })

  function epoch(target: Target): Epoch { return { generation, directory: workspaceDirectory(target.workspaceId) } }
  function current(target: Target, captured: Epoch): boolean {
    return captured.generation === generation && (captured.directory === undefined || captured.directory === workspaceDirectory(target.workspaceId))
  }
  function remember(target: Target, configuration: AgentConfiguration, captured: Epoch): void {
    if (current(target, captured) && configuration.matrix) matrices.set(key(target), { workspaceId: target.workspaceId, matrix: toRaw(configuration.matrix) })
  }
  function read(target: Target, current: AgentConfiguration | undefined, choices: AgentConfigurationSelection, composer = false): AgentConfiguration | undefined {
    const matrix = matrices.get(key(target))?.matrix
    if (!matrix) return undefined
    const configuration = cachedAgentConfiguration(matrix, current?.provider.id === target.provider ? toRaw(current) : undefined, choices)
    if (!configuration || composer && (configuration.commands === undefined || configuration.skills === undefined)) return undefined
    return { ...configuration, matrix }
  }
  function forget(target: Target): void { matrices.delete(key(target)) }

  return { remember, read, forget, epoch, current, workspaceDirectory }
})
