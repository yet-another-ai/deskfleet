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
  #installOnQuit = true

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
      let pauseOnMetered = true
      let installOnQuit = true
      try {
        const stored: unknown = JSON.parse(readFileSync(this.#path, "utf8"))
        if (!stored || typeof stored !== "object" || !("enabled" in stored)
          || typeof stored.enabled !== "boolean") throw new Error("Invalid automatic update settings")
        enabled = stored.enabled
        if ("pauseOnMetered" in stored) {
          if (typeof stored.pauseOnMetered !== "boolean") throw new Error("Invalid automatic update settings")
          pauseOnMetered = stored.pauseOnMetered
        }
        if ("installOnQuit" in stored) {
          if (typeof stored.installOnQuit !== "boolean") throw new Error("Invalid automatic update settings")
          installOnQuit = stored.installOnQuit
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      this.#enabled = enabled
      this.#pauseOnMetered = pauseOnMetered
      this.#installOnQuit = installOnQuit
      this.#onChange(this.get())
    }
    return {
      enabled: this.#enabled,
      pauseOnMetered: this.#pauseOnMetered,
      installOnQuit: this.#installOnQuit,
      installSource: this.#installSource,
    }
  }

  setEnabled(enabled: boolean): AutoDownloadUpdatesState {
    this.get()
    return this.#save(enabled, this.#pauseOnMetered, this.#installOnQuit)
  }

  setPauseOnMetered(enabled: boolean): AutoDownloadUpdatesState {
    this.get()
    return this.#save(this.#enabled!, enabled, this.#installOnQuit)
  }

  setInstallOnQuit(enabled: boolean): AutoDownloadUpdatesState {
    this.get()
    return this.#save(this.#enabled!, this.#pauseOnMetered, enabled)
  }

  #save(enabled: boolean, pauseOnMetered: boolean, installOnQuit: boolean): AutoDownloadUpdatesState {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify({ enabled, pauseOnMetered, installOnQuit }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#enabled = enabled
    this.#pauseOnMetered = pauseOnMetered
    this.#installOnQuit = installOnQuit
    const state = this.get()
    this.#onChange(state)
    return state
  }
}
