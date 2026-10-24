import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { LocalAgentState, ScreenCapturePermission } from "../../../../packages/client/src/local-agent.ts"

export interface LocalAgentConnection {
  readonly closed: boolean
  readonly screenCapturePermission: ScreenCapturePermission
  shutdown(): Promise<void>
  close(): void
}

export interface LocalAgentRuntime {
  connect(onDisconnect: (error: Error) => void, onPermissionChanged: (permission: ScreenCapturePermission) => void): Promise<LocalAgentConnection>
  /** Starts the daemon in this process; it is ready to accept connections once this resolves. */
  start(): Promise<void>
  waitForShutdown(): Promise<void>
  /** Stops a daemon this process started; a separately running daemon is left alone. */
  close(): Promise<void>
}

function unavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "ENOENT" || error.code === "ECONNREFUSED")
}

/** The preference owns explicit start/stop actions; quitting the app stops the daemon it hosts. */
export class LocalAgentController {
  readonly #path: string
  readonly #runtime: LocalAgentRuntime
  readonly #emit: (state: LocalAgentState) => void
  #state: LocalAgentState = { enabled: true, status: "stopped" }
  #connection: LocalAgentConnection | undefined
  #operation: Promise<LocalAgentState> | undefined

  constructor(path: string, runtime: LocalAgentRuntime, emit: (state: LocalAgentState) => void = () => {}) {
    this.#path = path
    this.#runtime = runtime
    this.#emit = emit
  }

  get state(): LocalAgentState { return { ...this.#state } }

  async initialize(): Promise<LocalAgentState> {
    try {
      try {
        const stored: unknown = JSON.parse(await readFile(this.#path, "utf8"))
        if (!stored || typeof stored !== "object" || !("localAgentEnabled" in stored)
          || typeof stored.localAgentEnabled !== "boolean") throw new Error("Invalid desktop settings")
        this.#state.enabled = stored.localAgentEnabled
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      // An external daemon is not stopped just because this client launches
      // with auto-start disabled. Explicitly switching off requests shutdown.
      if (this.#state.enabled) await this.#start()
      else {
        this.#connection = await this.#connectIfRunning()
        this.#update({ status: this.#connection ? "running" : "stopped", screenCapturePermission: this.#connection?.screenCapturePermission })
      }
    } catch (error) { this.#failed(error) }
    return this.state
  }

  setEnabled(enabled: boolean): Promise<LocalAgentState> {
    if (this.#operation) return Promise.reject(new Error("Local Agent is changing state"))
    this.#operation = (async () => {
      try {
        await mkdir(dirname(this.#path), { recursive: true })
        const temporary = `${this.#path}.tmp`
        await writeFile(temporary, JSON.stringify({ localAgentEnabled: enabled }, null, 2) + "\n", { mode: 0o600 })
        await rename(temporary, this.#path)
        this.#update({ enabled })
        if (enabled) await this.#start()
        else await this.#stop()
      } catch (error) { this.#failed(error) }
      return this.state
    })().finally(() => { this.#operation = undefined })
    return this.#operation
  }

  detach(): void {
    const connection = this.#connection
    this.#connection = undefined
    connection?.close()
  }

  /** Called when the app quits, after its windows have closed. */
  async close(): Promise<void> {
    this.detach()
    await this.#runtime.close()
  }

  #update(change: Partial<LocalAgentState>): void {
    this.#state = { ...this.#state, error: undefined, ...change }
    this.#emit(this.state)
  }

  #failed(error: unknown): void {
    this.#update({ status: "error", error: error instanceof Error ? error.message : String(error), screenCapturePermission: undefined })
  }

  async #connectIfRunning(): Promise<LocalAgentConnection | undefined> {
    if (this.#connection && !this.#connection.closed) return this.#connection
    try {
      let connection: LocalAgentConnection | undefined
      connection = await this.#runtime.connect(error => {
        if (!connection) return
        if (this.#connection !== connection) return
        this.#connection = undefined
        if (this.#state.status !== "stopping") this.#failed(error)
      }, permission => {
        if (!connection || this.#connection !== connection) return
        this.#update({ screenCapturePermission: permission })
      })
      return connection
    } catch (error) {
      if (unavailable(error)) return undefined
      throw error
    }
  }

  async #start(): Promise<void> {
    this.#update({ status: "starting", screenCapturePermission: undefined })
    this.#connection = await this.#connectIfRunning()
    if (!this.#connection) {
      await this.#runtime.start()
      this.#connection = await this.#connectIfRunning()
      if (!this.#connection) throw new Error("Local Agent did not become ready")
    }
    this.#update({ status: "running", screenCapturePermission: this.#connection.screenCapturePermission })
  }

  async #stop(): Promise<void> {
    this.#update({ status: "stopping", screenCapturePermission: undefined })
    this.#connection = await this.#connectIfRunning()
    if (this.#connection) {
      await this.#connection.shutdown()
      await this.#runtime.waitForShutdown()
      this.detach()
    }
    this.#update({ status: "stopped", screenCapturePermission: undefined })
  }
}
