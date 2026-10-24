import type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace } from "../../../apps/daemon/src/catalog-protocol.ts"

export type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorktree } from "../../../apps/daemon/src/catalog-protocol.ts"

export const CATALOG_CHANGED_EVENT = "deskfleet:catalog-changed"

/** Manage the persistent workspace catalog on the local daemon. */
export interface CatalogApi {
  list(): Promise<CatalogSnapshot>
  createWorkspace(name: string, directories: CatalogDirectory[]): Promise<CatalogWorkspace>
  updateWorkspace(workspaceId: string, name: string, directories: CatalogDirectory[]): Promise<CatalogWorkspace>
  deleteWorkspace(workspaceId: string): Promise<void>
  onChanged(listener: () => void): () => void
}
