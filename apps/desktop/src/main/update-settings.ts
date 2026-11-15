import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { AutoDownloadUpdatesState, UpdateInstallSource } from "../../../../packages/client/src/settings.ts"

/** Owns the desktop client's automatic update download preference. */
export class UpdateSettingsController {
  readonly #path: string
  readonly #onChange: (state: AutoDownloadUpdatesState) => void
  readonly #installSource: UpdateInstallSource
  #enabled: boolean | undefined
  #pauseOnMetered = true

  constructor(
    path: string,
    onChange: (state: AutoDownloadUpdatesState) => void = () => {},
    installSource: UpdateInstallSource = "desktop_installer",
  ) {
    this.#path = path
    this.#onChange = onChange
    this.#installSource = installSource
  }

  get(): AutoDownloadUpdatesState {
    if (this.#enabled === undefined) {
      let enabled = true
      try {
        const stored: unknown = JSON.parse(readFileSync(this.#path, "utf8"))
        if (!stored || typeof stored !== "object" || !("enabled" in stored)
          || typeof stored.enabled !== "boolean") throw new Error("Invalid automatic update settings")
        enabled = stored.enabled
        if ("pauseOnMetered" in stored) {
          if (typeof stored.pauseOnMetered !== "boolean") throw new Error("Invalid automatic update settings")
          this.#pauseOnMetered = stored.pauseOnMetered
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      this.#enabled = enabled
      this.#onChange(this.get())
    }
    return { enabled: this.#enabled, pauseOnMetered: this.#pauseOnMetered, installSource: this.#installSource }
  }

  setEnabled(enabled: boolean): AutoDownloadUpdatesState {
    return this.#save(enabled, this.get().pauseOnMetered)
  }

  setPauseOnMetered(enabled: boolean): AutoDownloadUpdatesState {
    return this.#save(this.get().enabled, enabled)
  }

  #save(enabled: boolean, pauseOnMetered: boolean): AutoDownloadUpdatesState {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify({ enabled, pauseOnMetered }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#enabled = enabled
    this.#pauseOnMetered = pauseOnMetered
    const state = this.get()
    this.#onChange(state)
    return state
  }
}
