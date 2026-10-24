import type { ScreenCapturePermission } from "../../../daemon/src/control-protocol.ts"

export type { ScreenCapturePermission } from "../../../daemon/src/control-protocol.ts"

export interface LocalAgentState {
  enabled: boolean
  status: "stopped" | "starting" | "running" | "stopping" | "error"
  error?: string
  screenCapturePermission?: ScreenCapturePermission
}

export interface LocalAgentSettingsApi {
  get(): Promise<LocalAgentState>
  setLocalAgentEnabled(enabled: boolean): Promise<LocalAgentState>
  onChanged(listener: (state: LocalAgentState) => void): () => void
}
