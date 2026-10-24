import type { CatalogSnapshot } from "../../../client/src/catalog.ts"

/** Deliberately beyond JavaScript's exact integer range. IDs stay strings end-to-end. */
export const workspaceId = "9007199254740993"
export const mainWorktreeId = "9007199254740995"
export const sessionWorktreeId = "9007199254740997"
export const sessionId = "9007199254741001"
export function catalogFixture(): CatalogSnapshot {
  return {
    teamId: "1", machineId: "9007199254740999", machineName: "test-host",
    workspaces: [{
      id: workspaceId, name: "storefront", worktrees: [
        { id: mainWorktreeId, workspaceId, directories: [{ path: "/code/web" }, { path: "/code/api" }] },
        { id: sessionWorktreeId, workspaceId, sessionId, directories: [{ path: "/worktrees/api/session" }] },
      ],
    }],
  }
}
