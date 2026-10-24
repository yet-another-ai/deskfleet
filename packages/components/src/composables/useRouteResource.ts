import { computed } from "vue"
import { useRoute } from "vue-router"
import type { MachineSummary } from "../stores/fleet-types.ts"
import { useFleetStore, type SessionLocation, type TerminalLocation, type WorkspaceLocation, type WorktreeLocation } from "../stores/fleet.ts"

/** The resource the current route shows, as context for the details panel. */
export type RouteResource =
  | ({ kind: "workspace" } & WorkspaceLocation)
  | ({ kind: "worktree" } & WorktreeLocation)
  | ({ kind: "session" } & SessionLocation)
  | ({ kind: "terminal" } & TerminalLocation)
  | { kind: "desktop"; machine: MachineSummary }

function param(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

export function useRouteResource() {
  const route = useRoute()
  const fleet = useFleetStore()

  const resource = computed<RouteResource | null>(() => {
    switch (route.name) {
      case "workspace": {
        const location = fleet.findWorkspace(param(route.params.workspaceId))
        return location && { kind: "workspace", ...location }
      }
      case "worktree": {
        const location = fleet.findWorktree(param(route.params.worktreeId))
        return location && { kind: "worktree", ...location }
      }
      case "session": {
        const location = fleet.findSession(param(route.params.sessionId))
        return location && { kind: "session", ...location }
      }
      case "terminal": {
        const location = fleet.findTerminal(param(route.params.terminalId))
        return location && { kind: "terminal", ...location }
      }
      case "machine-desktop": {
        const machine = fleet.findMachine(param(route.params.machineId))
        return machine && { kind: "desktop", machine }
      }
      case "new-session": {
        const location = fleet.newSessionTarget
        return location && { kind: "workspace", ...location }
      }
      default:
        return null
    }
  })

  /** Terminals and desktops outside a worktree have no Git changes to show. */
  const worktree = computed<WorktreeLocation | null>(() => {
    const value = resource.value
    if (!value || value.kind === "desktop" || value.kind === "workspace") return null
    if (value.kind === "terminal" || value.kind === "session") {
      return value.worktree ? fleet.findWorktree(value.worktree.id) : null
    }
    return value
  })

  return { resource, worktree }
}
