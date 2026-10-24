import { hostname } from "node:os"
import { validateControlParams } from "../../../daemon/src/control-request.ts"
import type { DesktopEvent, LocalDesktopTarget } from "../shared/desktop-media.ts"
import type { TerminalSessionEvent } from "../shared/terminal.ts"
import { DaemonClient } from "./daemon-client.ts"

/** Restricts IPC calls and events to the peer sessions owned by one renderer. */
export class DesktopMediaController {
  readonly #emit: (event: DesktopEvent) => void
  readonly #emitTerminal: (event: TerminalSessionEvent) => void
  readonly #emitCatalog: () => void
  readonly #emitProviders: () => void
  readonly #sessions = new Set<string>()
  #connection: Promise<DaemonClient> | null = null
  #disposed = false

  constructor(
    emit: (event: DesktopEvent) => void,
    emitTerminal: (event: TerminalSessionEvent) => void = () => {},
    emitCatalog: () => void = () => {},
    emitProviders: () => void = () => {},
  ) {
    this.#emit = emit
    this.#emitTerminal = emitTerminal
    this.#emitCatalog = emitCatalog
    this.#emitProviders = emitProviders
  }

  async invoke(method: string, params: unknown): Promise<unknown> {
    if (this.#disposed) throw new Error("Desktop window has closed")
    switch (method) {
      case "target":
        return this.#target()
      case "capabilities":
        return (await this.#connect()).call("capabilities", {})
      case "terminalList":
      case "terminalDial":
      case "terminalHangup":
      case "catalogList":
      case "providerList":
      case "providerCreate":
      case "providerUpdate":
      case "providerRemove":
      case "directoryList":
      case "workspaceCreate":
      case "workspaceUpdate":
      case "workspaceDelete": {
        const request = validateControlParams(method, params)
        return (await this.#connect()).call(method, request)
      }
      case "offer":
      case "agentOffer":
      case "terminalOffer": {
        const offer = validateControlParams(method, params)
        if (this.#sessions.has(offer.sessionId)) throw new Error("Desktop session already exists")
        // Reserve before awaiting connection so concurrent offers cannot reuse an ID.
        this.#sessions.add(offer.sessionId)
        try {
          const client = await this.#connect()
          if (!this.#sessions.has(offer.sessionId)) throw new Error("Desktop session was cancelled")
          return await client.call(method, offer)
        } catch (error) {
          this.#sessions.delete(offer.sessionId)
          throw error
        }
      }
      case "candidate": {
        const candidate = validateControlParams("candidate", params)
        this.#requireSession(candidate.sessionId)
        return (await this.#connect()).call("candidate", candidate)
      }
      case "start": {
        const start = validateControlParams("start", params)
        this.#requireSession(start.sessionId)
        return (await this.#connect()).call("start", start)
      }
      case "close": {
        const close = validateControlParams("close", params)
        if (!this.#sessions.delete(close.sessionId)) return
        // Never reconnect just to close a peer on an already disconnected socket.
        const client = await this.#connection
        if (client && !client.closed) await client.call("close", close)
        return
      }
      default:
        throw new Error("Unknown desktop operation")
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#sessions.clear()
    const connection = this.#connection
    this.#connection = null
    void connection?.then((client) => client.close(), () => {})
  }

  #requireSession(id: string): void {
    if (!this.#sessions.has(id)) throw new Error("Desktop session is not owned by this window")
  }

  #connect(): Promise<DaemonClient> {
    if (this.#disposed) return Promise.reject(new Error("Desktop window has closed"))
    if (this.#connection) return this.#connection
    const connection = DaemonClient.connect(
      (event) => {
        if (this.#connection !== connection) return
        if (event.kind === "catalogChanged") this.#emitCatalog()
        else if (event.kind === "providersChanged") this.#emitProviders()
        else if (event.kind === "terminalChanged" || event.kind === "terminalHungup") this.#emitTerminal(event)
        else if ("sessionId" in event && this.#sessions.has(event.sessionId)) this.#emit(event)
      },
      (error) => {
        if (this.#connection !== connection) return
        this.#connection = null
        for (const sessionId of this.#sessions) this.#emit({ sessionId, kind: "error", error: error.message })
        this.#sessions.clear()
      },
    ).then((client) => {
      if (this.#disposed || this.#connection !== connection) {
        client.close()
        throw new Error("Desktop connection was cancelled")
      }
      return client
    }).catch((error: unknown) => {
      if (this.#connection === connection) this.#connection = null
      throw error
    })
    this.#connection = connection
    return connection
  }

  async #target(): Promise<LocalDesktopTarget> {
    const target = { id: "local-daemon" as const, name: hostname(), desktop: process.platform !== "linux" }
    try {
      const client = await this.#connect()
      return { ...target, ...client.info!, online: true }
    } catch (error) {
      const unavailable = error instanceof Error && "code" in error
        && (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      return {
        ...target,
        online: false,
        error: unavailable ? "The local daemon is not running" : error instanceof Error ? error.message : String(error),
      }
    }
  }
}
