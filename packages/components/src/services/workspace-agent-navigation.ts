import type { RouteLocationResolved } from "vue-router"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"

import { createGlobalState, useStorage } from "@vueuse/core"

/** The viewing device owns the navigation preference. Machine data stays in its registration. */
export const useWorkspaceAgentMode = createGlobalState(() => useStorage("deskfleet.workspace-agent.enabled", false, undefined, { writeDefaults: false, flush: "sync" }))

export function usesWorkspaceNavigation(client: DeskfleetDesktopApi, accountAvailable = true): boolean {
  return useWorkspaceAgentMode().value && supportsWorkspaceNavigation(client, accountAvailable)
}

/** The shell can show projects before any selected machine advertises its agent. */
export function supportsWorkspaceNavigation(client: DeskfleetDesktopApi, accountAvailable = true): boolean {
  return !!(client.remoteWorkspaceAgent || client.superAgent || (accountAvailable && client.localChannels))
}

/** The default agent's private worker directory has no separate project conversation. */
export function isPrivateAgentWorkspace(workspace: { directories: readonly { path: string }[] }): boolean {
  const directory = workspace.directories.length === 1 && workspace.directories[0]
  return !!directory && /(?:^|[\\/])super-agent-files[\\/][a-f0-9]{64}[\\/]?$/.test(directory.path)
}

export function workspaceRouteMachine(route: Pick<RouteLocationResolved, "name" | "query">) {
  if (route.name === "session") return typeof route.query.superMachine === "string" ? route.query.superMachine : undefined
  if (route.name === "new-project" || route.name === "new-session" || route.name === "workspace-agent") {
    return typeof route.query.machine === "string" ? route.query.machine : undefined
  }
}

/** The host can run a different OS than the viewing device. */
export function projectDirectoryName(path: string): string {
  const separator = /^(?:[a-z]:[\\/]|\\\\)/iu.test(path) ? /[\\/]/u : "/"
  return path.split(separator).filter(Boolean).at(-1) ?? path
}

/** Workspace IDs are scoped to one machine in the current Team. */
export function workspaceAgentRoute(machineId: string, workspaceId: string | null, teamId?: string) {
  const query = { machine: machineId, ...(teamId && { team: teamId }) }
  return workspaceId === null ? { name: "new-session", query }
    : { name: "workspace-agent", params: { workspaceId }, query }
}

/** Carry the originating workspace through the existing Worker page, scoped to its machine. */
export function workspaceSessionRoute(machineId: string, workspaceId: string | null, sessionId: string, teamId?: string) {
  return { name: "session", params: { sessionId }, query: { superFrom: workspaceId ?? "", superMachine: machineId, ...(teamId && { team: teamId }) } }
}
