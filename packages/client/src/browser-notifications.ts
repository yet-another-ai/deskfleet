import type { SettingsApi } from "./settings.ts"
import { browserNotificationChanges } from "./browser-notification-settings.ts"
import type { TaskNotification } from "./task-notification-monitor.ts"

export type BrowserNotificationPermission = NotificationPermission | "unsupported"

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || !window.isSecureContext || typeof Notification === "undefined") return "unsupported"
  return Notification.permission
}

/** Call directly from a user gesture, before any asynchronous work. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const permission = getBrowserNotificationPermission()
  if (permission !== "default") return permission
  const result = await Notification.requestPermission()
  browserNotificationChanges.dispatchEvent(new Event("change"))
  return result
}

/** Owns every notification for the current browser page and account. */
export class BrowserNotifications {
  readonly #settings: Pick<SettingsApi, "getNotifications">
  readonly #title: (kind: TaskNotification["kind"]) => string
  readonly #onError: (error: unknown) => void
  readonly #onSelect: ((event: TaskNotification) => void) | undefined
  readonly #notifications = new Set<Notification>()
  #epoch = 0
  #closed = false

  constructor(
    settings: Pick<SettingsApi, "getNotifications">,
    title: (kind: TaskNotification["kind"]) => string,
    onError: (error: unknown) => void = error => console.error("Could not show browser notification", error),
    onSelect?: (event: TaskNotification) => void,
  ) {
    this.#settings = settings
    this.#title = title
    this.#onError = onError
    this.#onSelect = onSelect
  }

  async notify(event: TaskNotification): Promise<void> {
    const epoch = this.#epoch
    try {
      if (this.#closed || getBrowserNotificationPermission() !== "granted") return
      const settings = await this.#settings.getNotifications()
      if (this.#closed || epoch !== this.#epoch || !settings.enabled || !settings[event.kind]
        || getBrowserNotificationPermission() !== "granted") return
      const body = event.detail && event.title ? `${event.title}\n${event.detail}` : (event.detail ?? event.title)
      const notification = new Notification(this.#title(event.kind), { body })
      this.#notifications.add(notification)
      notification.onclick = () => {
        this.#dismiss(notification)
        try {
          window.focus()
          this.#onSelect?.(event)
        } catch (error) { this.#onError(error) }
      }
      notification.onclose = () => { this.#release(notification) }
      notification.onerror = error => { this.#release(notification); this.#onError(error) }
    } catch (error) { this.#onError(error) }
  }

  clear(): void {
    this.#epoch++
    for (const notification of this.#notifications) this.#dismiss(notification)
  }

  close(): void {
    this.#closed = true
    this.clear()
  }

  #release(notification: Notification): void {
    this.#notifications.delete(notification)
    notification.onclick = null
    notification.onclose = null
    notification.onerror = null
  }

  #dismiss(notification: Notification): void {
    this.#release(notification)
    try { notification.close() } catch (error) { this.#onError(error) }
  }
}
