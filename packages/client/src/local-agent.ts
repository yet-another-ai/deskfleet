import type { DesktopPermissionsState } from "../../../apps/daemon/src/control-protocol.ts"

export type { DesktopPermission, DesktopPermissionKind, DesktopPermissionsState } from "../../../apps/daemon/src/control-protocol.ts"

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
