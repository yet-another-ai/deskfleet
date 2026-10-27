import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { validateNotificationSettings, type NotificationSettings } from "../../../../packages/client/src/settings.ts"

export { validateNotificationSettings } from "../../../../packages/client/src/settings.ts"

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
