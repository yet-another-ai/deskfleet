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
  | { kind: "control"; machine: MachineSummary }

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
      case "machine-control": {
        const machine = fleet.findMachine(param(route.params.machineId))
        if (!machine) return null
        const tab = ["terminal", "desktop", "files"].find(value => value === route.query.tab)
          ?? (machine.desktop ? "desktop" : "terminal")
        if (tab === "terminal") {
          const location = typeof route.query.terminal === "string" ? fleet.findTerminal(route.query.terminal) : null
          if (location?.machine.id === machine.id && !location.workspace && !location.worktree) return { kind: "terminal", ...location }
        }
        return { kind: "control", machine }
      }
      case "new-session": {
        const location = fleet.newSessionTarget
        return location && { kind: "workspace", ...location }
      }
      default:
        return null
    }
  })

  /** Machine control and terminals outside a worktree have no Git changes to show. */
  const worktree = computed<WorktreeLocation | null>(() => {
    const value = resource.value
    if (!value || value.kind === "control" || value.kind === "workspace") return null
    if (value.kind === "terminal" || value.kind === "session") {
      return value.worktree ? fleet.findWorktree(value.worktree.id) : null
    }
    return value
  })

  return { resource, worktree }
}
