import type { UpdateState } from "../../../../packages/client/src/updates.ts"

export const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000
export const UPDATE_NETWORK_CHECK_INTERVAL = 10 * 1000

export interface UpdateDriver {
  check(): Promise<string | null>
  download(progress: (percent: number) => void, signal?: AbortSignal): Promise<void>
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
  #pauseOnMetered = true
  readonly #isNetworkMetered: () => Promise<boolean>
  #networkCheck: Promise<boolean> | undefined
  #networkTimer: ReturnType<typeof setInterval> | undefined
  #automaticAbort: AbortController | undefined
  #pausedOnMetered = false
  #state: UpdateState
  #timer: ReturnType<typeof setInterval> | undefined
  #checking: Promise<void> | undefined
  #downloading: Promise<void> | undefined
  #installing: Promise<void> | undefined
  #downloadedVersion: string | undefined
  #closed = false

  constructor(driver: UpdateDriver | null, publish: (state: UpdateState) => void, beforeInstall: () => Promise<void>, currentVersion?: string, autoDownload = true, isNetworkMetered: () => Promise<boolean> = async () => false) {
    this.#driver = driver
    this.#publish = publish
    this.#beforeInstall = beforeInstall
    this.#currentVersion = currentVersion
    this.#autoDownload = autoDownload
    this.#isNetworkMetered = isNetworkMetered
    this.#state = { status: driver ? "idle" : "disabled" }
  }

  get(): UpdateState {
    return { ...this.#state, ...(this.#currentVersion ? { currentVersion: this.#currentVersion } : {}) }
  }

  setAutoDownload(enabled: boolean): void {
    this.setDownloadPreferences(enabled, this.#pauseOnMetered)
  }

  setDownloadPreferences(enabled: boolean, pauseOnMetered: boolean): void {
    this.#autoDownload = enabled
    this.#pauseOnMetered = pauseOnMetered
    if (enabled && this.#state.status === "available" && this.#state.version) {
      this.#startAutoDownload(this.#state.version)
    }
    void this.#refreshNetworkPolicy()
  }

  start(): void {
    if (this.#closed || !this.#driver || this.#timer) return
    this.#timer = setInterval(() => { void this.check().catch(() => {}) }, UPDATE_CHECK_INTERVAL)
    this.#timer.unref()
    this.#networkTimer = setInterval(() => { void this.#refreshNetworkPolicy() }, UPDATE_NETWORK_CHECK_INTERVAL)
    this.#networkTimer.unref()
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
        this.#pausedOnMetered = false
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
    const abort = new AbortController()
    const downloading = (async () => {
      const metered = this.#pauseOnMetered && await this.#networkMetered()
      if (this.#closed) return
      if (!this.#autoDownload || (metered && this.#pauseOnMetered && !this.#installing)) {
        this.#pausedOnMetered = Boolean(metered)
        this.#update({ status: "available", version })
        return
      }
      this.#pausedOnMetered = false
      this.#automaticAbort = abort
      await this.#download(version, abort.signal)
    })().catch(error => {
      if (abort.signal.aborted) {
        this.#update({ status: "available", version })
        return
      }
      if (!this.#installing) this.#update({ status: "available", version })
      throw error
    }).finally(() => {
      this.#automaticAbort = undefined
      this.#downloading = undefined
      // A preference may change while cancellation is settling.
      if (abort.signal.aborted && !this.#pauseOnMetered && this.#autoDownload) this.#startAutoDownload(version)
    })
    this.#downloading = downloading
    void downloading.catch(() => {})
  }

  #networkMetered(): Promise<boolean> {
    this.#networkCheck ??= this.#isNetworkMetered().catch(() => false).finally(() => { this.#networkCheck = undefined })
    return this.#networkCheck
  }

  async #refreshNetworkPolicy(): Promise<void> {
    if (this.#closed || !this.#driver || !this.#autoDownload || !this.#pauseOnMetered || this.#installing
      || (!this.#automaticAbort && !this.#pausedOnMetered)) return
    const metered = await this.#networkMetered()
    if (this.#closed || !this.#autoDownload || !this.#pauseOnMetered || this.#installing) return
    if (metered && this.#automaticAbort) {
      this.#pausedOnMetered = true
      this.#automaticAbort.abort()
    } else if (!metered && this.#pausedOnMetered && this.#state.status === "available" && this.#state.version) {
      this.#startAutoDownload(this.#state.version)
    }
  }

  async #download(version: string, signal?: AbortSignal): Promise<void> {
    this.#update({ status: "downloading", version, percent: 0 })
    await this.#driver!.download(percent => {
      if (signal?.aborted) return
      if (!Number.isFinite(percent)) return
      const progress = Math.max(0, Math.min(100, Math.floor(percent)))
      if (progress !== this.#state.percent) this.#update({ status: "downloading", version, percent: progress })
    }, signal)
    signal?.throwIfAborted()
    if (this.#closed) return
    this.#downloadedVersion = version
    this.#update({ status: "downloaded", version, percent: 100 })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#networkTimer) clearInterval(this.#networkTimer)
    this.#networkTimer = undefined
    this.#automaticAbort?.abort()
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
