import type { DesktopPermissionsState } from "@deskfleet/protocol/control"

export type { DesktopPermission, DesktopPermissionKind, DesktopPermissionsState } from "@deskfleet/protocol/control"

export interface LocalAgentState extends Partial<DesktopPermissionsState> {
  enabled: boolean
  status: "stopped" | "starting" | "running" | "stopping" | "error"
  error?: string
}

export interface LocalAgentSettingsApi {
  get(): Promise<LocalAgentState>
  setLocalAgentEnabled(enabled: boolean): Promise<LocalAgentState>
  onChanged(listener: (state: LocalAgentState) => void): () => void
}
