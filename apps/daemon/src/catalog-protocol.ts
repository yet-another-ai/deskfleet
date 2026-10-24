import type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorkspaceSession, CatalogWorktree } from "@deskfleet/native"

// These records are generated from the Rust napi boundary; IDs stay decimal strings.
export type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorkspaceSession, CatalogWorktree }

export interface ManagedWorkspaceSession extends CatalogWorkspaceSession {
  worktree: CatalogWorktree
}

export interface CatalogMethods {
  catalogList: { params: Record<string, never>; result: CatalogSnapshot }
  workspaceCreate: { params: { name: string; directories: CatalogDirectory[] }; result: CatalogWorkspace }
  workspaceUpdate: { params: { workspaceId: string; name: string; directories: CatalogDirectory[] }; result: CatalogWorkspace }
  workspaceDelete: { params: { workspaceId: string }; result: null }
  workspaceSessionCreate: { params: { workspaceId: string }; result: ManagedWorkspaceSession }
  workspaceSessionDestroy: { params: { sessionId: string }; result: null }
}

export type CatalogEvent = { kind: "catalogChanged" }
export type CatalogRequest = {
  [M in keyof CatalogMethods]: { method: M; params: CatalogMethods[M]["params"] }
}[keyof CatalogMethods]

export function resourceId(value: unknown): void {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error("Invalid catalog resource ID")
  }
}

function name(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 256) {
    throw new Error("Catalog names must contain between 1 and 256 characters")
  }
}

export function validateCatalogParams(method: keyof CatalogMethods, params: Record<string, unknown>): void {
  if (method === "workspaceUpdate" || method === "workspaceDelete" || method === "workspaceSessionCreate") resourceId(params.workspaceId)
  if (method === "workspaceSessionDestroy") resourceId(params.sessionId)
  if (method !== "workspaceCreate" && method !== "workspaceUpdate") return
  name(params.name)
  if (!Array.isArray(params.directories) || params.directories.length === 0) throw new Error("A workspace needs at least one directory")
  const paths = new Set<string>()
  for (const directory of params.directories as unknown[]) {
    if (!directory || typeof directory !== "object" || !("path" in directory) || "name" in directory) throw new Error("Directories contain only paths")
    if (typeof directory.path !== "string" || !directory.path || directory.path.includes("\0") || directory.path.length > 4096) {
      throw new Error("Invalid directory path")
    }
    if (paths.has(directory.path)) throw new Error("Workspace directory paths must be unique")
    paths.add(directory.path)
  }
}
