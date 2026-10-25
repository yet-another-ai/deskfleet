import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { NotificationSettings } from "../../../../packages/client/src/settings.ts"

export function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== "object"
    || !("enabled" in value) || typeof value.enabled !== "boolean"
    || !("taskCompleted" in value) || typeof value.taskCompleted !== "boolean"
    || !("taskNeedsInput" in value) || typeof value.taskNeedsInput !== "boolean") {
    throw new Error("Notification settings must contain boolean preferences")
  }
  return { enabled: value.enabled, taskCompleted: value.taskCompleted, taskNeedsInput: value.taskNeedsInput }
}

/** Preferences belong to this desktop installation, independently of the selected machine. */
export class NotificationSettingsController {
  readonly #path: string
  #settings: NotificationSettings | undefined

  constructor(path: string) { this.#path = path }

  get(): NotificationSettings {
    if (!this.#settings) {
      try {
        this.#settings = validateNotificationSettings(JSON.parse(readFileSync(this.#path, "utf8")))
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        this.#settings = { enabled: true, taskCompleted: true, taskNeedsInput: true }
      }
    }
    return { ...this.#settings }
  }

  set(value: NotificationSettings): NotificationSettings {
    const settings = validateNotificationSettings(value)
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#settings = settings
    return { ...settings }
  }
}
