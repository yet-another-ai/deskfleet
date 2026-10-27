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

export interface WorktreeRootState {
  root: string | null
  defaultRoot: string
}

export interface NotificationSettings {
  enabled: boolean
  taskCompleted: boolean
  taskNeedsInput: boolean
}

export function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== "object"
    || !("enabled" in value) || typeof value.enabled !== "boolean"
    || !("taskCompleted" in value) || typeof value.taskCompleted !== "boolean"
    || !("taskNeedsInput" in value) || typeof value.taskNeedsInput !== "boolean") {
    throw new Error("Notification settings must contain boolean preferences")
  }
  return { enabled: value.enabled, taskCompleted: value.taskCompleted, taskNeedsInput: value.taskNeedsInput }
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SettingsApi extends LocalAgentSettingsApi {
  getLaunchAtStartup(): Promise<LaunchAtStartupState>
  setLaunchAtStartup(enabled: boolean): Promise<LaunchAtStartupState>
  getKeepAwake(): Promise<KeepAwakeState>
  setKeepAwake(enabled: boolean): Promise<KeepAwakeState>
  getWorktreeRoot(): Promise<WorktreeRootState>
  setWorktreeRoot(root: string | null): Promise<WorktreeRootState>
  chooseWorktreeRoot(): Promise<string | null>
  getNotifications(): Promise<NotificationSettings>
  setNotifications(settings: NotificationSettings): Promise<NotificationSettings>
}
