import type { LocalAgentSettingsApi } from "./local-agent.ts"

export const SETTINGS_CHANNEL = "deskfleet:settings"
export const SETTINGS_CHANGED_EVENT = "deskfleet:settings-changed"

export interface LaunchAtStartupState {
  available: boolean
  enabled: boolean
}

export interface KeepAwakeState {
  enabled: boolean
}

export interface NotificationSettings {
  enabled: boolean
  taskCompleted: boolean
  taskNeedsInput: boolean
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SettingsApi extends LocalAgentSettingsApi {
  getLaunchAtStartup(): Promise<LaunchAtStartupState>
  setLaunchAtStartup(enabled: boolean): Promise<LaunchAtStartupState>
  getKeepAwake(): Promise<KeepAwakeState>
  setKeepAwake(enabled: boolean): Promise<KeepAwakeState>
  getNotifications(): Promise<NotificationSettings>
  setNotifications(settings: NotificationSettings): Promise<NotificationSettings>
}
