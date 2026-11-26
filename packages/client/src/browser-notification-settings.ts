import { validateNotificationSettings, type SettingsApi } from "./settings.ts"

export const browserNotificationStorageKey = "deskfleet.notifications"
/** Same-page changes go here; other pages receive a native storage or permission event. */
export const browserNotificationChanges = new EventTarget()

/** Preferences belong to this browser origin and are independent of its permission grant. */
export function createBrowserNotificationSettings(storage: Pick<Storage, "getItem" | "setItem">): Pick<SettingsApi, "getNotifications" | "setNotifications"> {
  return {
    async getNotifications() {
      const saved = storage.getItem(browserNotificationStorageKey)
      return saved === null
        ? { enabled: true, taskCompleted: true, taskNeedsInput: true }
        : validateNotificationSettings(JSON.parse(saved))
    },
    async setNotifications(value) {
      const settings = validateNotificationSettings(value)
      storage.setItem(browserNotificationStorageKey, JSON.stringify(settings))
      browserNotificationChanges.dispatchEvent(new Event("change"))
      return settings
    },
  }
}
