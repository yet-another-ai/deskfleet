import { Notification } from "electron"
import type { NotificationSettings } from "../../../../packages/client/src/settings.ts"
import { t } from "./i18n.ts"
import type { TaskNotification } from "./task-notification-monitor.ts"

export class DesktopNotifications {
  readonly #settings: { get(): NotificationSettings }
  readonly #onClick: () => void
  readonly #notifications = new Set<Notification>()
  #closed = false

  constructor(settings: { get(): NotificationSettings }, onClick: () => void) {
    this.#settings = settings
    this.#onClick = onClick
  }

  notify(event: TaskNotification): void {
    if (this.#closed) return
    let notification: Notification | undefined
    try {
      const settings = this.#settings.get()
      if (!settings.enabled || !settings[event.kind] || !Notification.isSupported()) return
      notification = new Notification({ title: t(`notification.${event.kind}`), body: event.title })
      const current = notification
      this.#notifications.add(current)
      current.once("click", () => {
        this.#release(current)
        try { this.#onClick() } catch (error) { console.error("Could not open desktop notification", error) }
      })
      current.on("close", (details) => {
        // Windows keeps timed-out notifications clickable in Action Center.
        if (details.reason !== "timedOut") this.#release(current)
      })
      current.once("failed", (_event, error) => {
        this.#release(current)
        console.error("Could not show desktop notification", error)
      })
      current.show()
    } catch (error) {
      if (notification) this.#dismiss(notification)
      console.error("Could not show desktop notification", error)
    }
  }

  close(): void {
    this.#closed = true
    for (const notification of this.#notifications) this.#dismiss(notification)
  }

  #release(notification: Notification): void {
    this.#notifications.delete(notification)
    notification.removeAllListeners()
  }

  #dismiss(notification: Notification): void {
    this.#release(notification)
    try { notification.close() } catch (error) { console.error("Could not close desktop notification", error) }
  }
}
