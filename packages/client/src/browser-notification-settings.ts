import { validateNotificationSettings, type SettingsApi } from "./settings.ts"

const storageKey = "deskfleet.notifications"

/** Preferences belong to this browser origin and are independent of its permission grant. */
export function createBrowserNotificationSettings(storage: Pick<Storage, "getItem" | "setItem">): Pick<SettingsApi, "getNotifications" | "setNotifications"> {
  return {
    async getNotifications() {
      const saved = storage.getItem(storageKey)
      return saved === null
        ? { enabled: true, taskCompleted: true, taskNeedsInput: true }
        : validateNotificationSettings(JSON.parse(saved))
    },
    async setNotifications(value) {
      const settings = validateNotificationSettings(value)
      storage.setItem(storageKey, JSON.stringify(settings))
      return settings
    },
  }
}
