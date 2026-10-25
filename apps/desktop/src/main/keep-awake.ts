import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PowerSaveBlocker } from "electron"
import type { KeepAwakeState } from "../../../../packages/client/src/settings.ts"

/** Owns the app's sleep blocker, independently of its windows and local Agent. */
export class KeepAwakeController {
  readonly #path: string
  readonly #powerSaveBlocker: Pick<PowerSaveBlocker, "start" | "stop">
  #blockerId: number | undefined
  #loaded = false

  constructor(path: string, powerSaveBlocker: Pick<PowerSaveBlocker, "start" | "stop">) {
    this.#path = path
    this.#powerSaveBlocker = powerSaveBlocker
  }

  get(): KeepAwakeState {
    if (!this.#loaded) {
      let enabled = false
      try {
        const stored: unknown = JSON.parse(readFileSync(this.#path, "utf8"))
        if (!stored || typeof stored !== "object" || !("enabled" in stored)
          || typeof stored.enabled !== "boolean") throw new Error("Invalid Keep Awake settings")
        enabled = stored.enabled
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      this.#apply(enabled)
      this.#loaded = true
    }
    return { enabled: this.#blockerId !== undefined }
  }

  setEnabled(enabled: boolean): KeepAwakeState {
    const previous = this.#blockerId !== undefined
    this.#apply(enabled)
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.tmp`
      writeFileSync(temporary, JSON.stringify({ enabled }, null, 2) + "\n", { mode: 0o600 })
      renameSync(temporary, this.#path)
    } catch (error) {
      this.#apply(previous)
      throw error
    }
    this.#loaded = true
    return { enabled }
  }

  /** Releases the blocker on real app exit without changing the saved preference. */
  close(): void {
    this.#apply(false)
  }

  #apply(enabled: boolean): void {
    if (enabled && this.#blockerId === undefined) {
      this.#blockerId = this.#powerSaveBlocker.start("prevent-app-suspension")
    } else if (!enabled && this.#blockerId !== undefined) {
      this.#powerSaveBlocker.stop(this.#blockerId)
      this.#blockerId = undefined
    }
  }
}
