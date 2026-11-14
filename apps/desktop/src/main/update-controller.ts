import type { UpdateState } from "../../../../packages/client/src/updates.ts"

export const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000

export interface UpdateDriver {
  check(): Promise<string | null>
  download(progress: (percent: number) => void): Promise<void>
  install(failed: (error: Error) => void): void
  close(): void
}

/** The main process owns checks and update consent, including while windows are hidden. */
export class UpdateController {
  readonly #driver: UpdateDriver | null
  readonly #publish: (state: UpdateState) => void
  readonly #beforeInstall: () => Promise<void>
  readonly #currentVersion: string | undefined
  #autoDownload: boolean
  #state: UpdateState
  #timer: ReturnType<typeof setInterval> | undefined
  #checking: Promise<void> | undefined
  #downloading: Promise<void> | undefined
  #installing: Promise<void> | undefined
  #downloadedVersion: string | undefined
  #closed = false

  constructor(driver: UpdateDriver | null, publish: (state: UpdateState) => void, beforeInstall: () => Promise<void>, currentVersion?: string, autoDownload = true) {
    this.#driver = driver
    this.#publish = publish
    this.#beforeInstall = beforeInstall
    this.#currentVersion = currentVersion
    this.#autoDownload = autoDownload
    this.#state = { status: driver ? "idle" : "disabled" }
  }

  get(): UpdateState {
    return { ...this.#state, ...(this.#currentVersion ? { currentVersion: this.#currentVersion } : {}) }
  }

  setAutoDownload(enabled: boolean): void {
    this.#autoDownload = enabled
    if (enabled && this.#state.status === "available" && this.#state.version) {
      this.#startAutoDownload(this.#state.version)
    }
  }

  start(): void {
    if (this.#closed || !this.#driver || this.#timer) return
    this.#timer = setInterval(() => { void this.check().catch(() => {}) }, UPDATE_CHECK_INTERVAL)
    this.#timer.unref()
    void this.check().catch(() => {})
  }

  check(): Promise<void> {
    if (this.#checking) return this.#checking
    if (this.#closed || !this.#driver || this.#installing || this.#downloading || this.#state.status === "installing") return Promise.resolve()
    const previous = this.#state
    this.#update({ status: "checking", version: previous.version })
    this.#checking = this.#driver.check().then(version => {
      if (!version) {
        this.#downloadedVersion = undefined
        this.#update({ status: "idle" })
        return
      }
      if (this.#downloadedVersion === version) {
        this.#update({ status: "downloaded", version, percent: 100 })
        return
      }
      this.#downloadedVersion = undefined
      if (this.#autoDownload && !this.#installing) this.#startAutoDownload(version)
      else this.#update({ status: "available", version })
    }).catch(error => {
      // Background checks must not look like a failed install: the notice treats
      // every error as Retry → install(), which would shut down the hosted daemon.
      if (this.#downloadedVersion) {
        this.#update(previous.status === "error" ? previous : { status: "downloaded", version: this.#downloadedVersion, percent: 100 })
      } else {
        const version = previous.version
        this.#update(version ? { status: "available", version } : { status: "idle" })
      }
      throw error
    }).finally(() => { this.#checking = undefined })
    return this.#checking
  }

  /** One click authorizes installation (downloading first if needed); background checks never call this. */
  install(): Promise<void> {
    if (this.#installing) return this.#installing
    if (this.#closed || !this.#driver) return Promise.reject(new Error("Application updates are unavailable"))
    if (this.#state.status === "installing") return Promise.resolve()
    this.#installing = this.#performInstall().catch(error => {
      this.#fail(error)
      throw error
    }).finally(() => { this.#installing = undefined })
    return this.#installing
  }

  async #performInstall(): Promise<void> {
    // The updater's check selects the download target. Wait before using that target.
    if (this.#checking) await this.#checking
    if (this.#downloading) await this.#downloading
    if (this.#closed) return
    const version = this.#state.version
    if (!version) throw new Error("No application update is available")
    if (this.#downloadedVersion !== version) {
      await this.#download(version)
      if (this.#closed) return
    }
    this.#update({ status: "installing", version, percent: 100 })
    await this.#beforeInstall()
    // A normal quit while shutdown was pending must not become an update install.
    if (this.#closed) return
    this.#driver!.install(error => { this.#fail(error) })
  }

  #startAutoDownload(version: string): void {
    if (this.#closed || !this.#driver || this.#downloading || this.#installing || this.#state.status === "installing" || this.#downloadedVersion === version) return
    const downloading = this.#download(version).catch(error => {
      if (!this.#installing) this.#update({ status: "available", version })
      throw error
    }).finally(() => {
      this.#downloading = undefined
    })
    this.#downloading = downloading
    void downloading.catch(() => {})
  }

  async #download(version: string): Promise<void> {
    this.#update({ status: "downloading", version, percent: 0 })
    await this.#driver!.download(percent => {
      if (!Number.isFinite(percent)) return
      const progress = Math.max(0, Math.min(100, Math.floor(percent)))
      if (progress !== this.#state.percent) this.#update({ status: "downloading", version, percent: progress })
    })
    if (this.#closed) return
    this.#downloadedVersion = version
    this.#update({ status: "downloaded", version, percent: 100 })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#driver?.close()
  }

  #update(state: UpdateState): void {
    if (this.#closed) return
    this.#state = state
    this.#publish(this.get())
  }

  #fail(error: unknown): void {
    this.#update({
      status: "error", version: this.#state.version, percent: this.#state.percent,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
