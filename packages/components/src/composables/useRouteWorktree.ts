import { computed } from "vue"
import { useRoute } from "vue-router"
import { useFleetStore, type WorktreeLocation } from "../stores/fleet.ts"

function param(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

/** The Session-owned worktree whose Git changes the current page can inspect. */
export function useRouteWorktree() {
  const route = useRoute()
  const fleet = useFleetStore()

  return computed<WorktreeLocation | null>(() => {
    switch (route.name) {
      case "worktree":
        return fleet.findWorktree(param(route.params.worktreeId))
      case "session": {
        const worktree = fleet.findSession(param(route.params.sessionId))?.worktree
        return worktree ? fleet.findWorktree(worktree.id) : null
      }
      case "terminal": {
        const worktree = fleet.findTerminal(param(route.params.terminalId))?.worktree
        return worktree ? fleet.findWorktree(worktree.id) : null
      }
      default:
        return null
    }
  })
}
