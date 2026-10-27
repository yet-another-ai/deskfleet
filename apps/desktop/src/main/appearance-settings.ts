import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_APPEARANCE_SETTINGS, validateAppearanceSettings, type AppearanceSettings } from "../../../../packages/client/src/appearance.ts"

/** Appearance belongs to the desktop installation, independently of selected machines. */
export class AppearanceSettingsController {
  readonly #path: string
  #settings: AppearanceSettings | undefined

  constructor(path: string) { this.#path = path }

  get(): AppearanceSettings {
    if (!this.#settings) {
      try {
        this.#settings = validateAppearanceSettings(JSON.parse(readFileSync(this.#path, "utf8")))
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        this.#settings = { ...DEFAULT_APPEARANCE_SETTINGS }
      }
    }
    return { ...this.#settings }
  }

  set(value: AppearanceSettings): AppearanceSettings {
    const settings = validateAppearanceSettings(value)
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#settings = settings
    return { ...settings }
  }
}
