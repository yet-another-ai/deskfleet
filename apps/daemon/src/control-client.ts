import { createConnection, type Socket } from "node:net"
import { readDaemonDiscovery } from "./control-discovery.ts"
import {
  MAX_CONTROL_MESSAGE_BYTES,
  type ControlMessage,
  type ControlMethod,
  type ControlMethods,
  type DaemonDiscovery,
  type DaemonEvent,
  type LocalDaemonInfo,
} from "./control-protocol.ts"

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

/** Peer loss arrives as a socket error before `close`. Report one disconnection. */
function disconnectError(error: NodeJS.ErrnoException): Error {
  if (
    error.code === "ECONNRESET" ||
    error.code === "EPIPE" ||
    error.code === "ECONNABORTED" ||
    error.code === "EOF"
  ) {
    return new Error("The local daemon disconnected")
  }
  return error
}

/** One authenticated connection owns only this window's transient media peers. */
export class DaemonClient {
  readonly #socket: Socket
  readonly #pending = new Map<number, PendingRequest>()
  readonly #onEvent: (event: DaemonEvent) => void
  readonly #onDisconnect: (error: Error) => void
  #nextId = 0
  #buffer = ""
  #closed = false
  info: LocalDaemonInfo | null = null

  private constructor(
    discovery: DaemonDiscovery,
    onEvent: (event: DaemonEvent) => void,
    onDisconnect: (error: Error) => void,
  ) {
    this.#onEvent = onEvent
    this.#onDisconnect = onDisconnect
    this.#socket = createConnection(discovery.endpoint)
    this.#socket.setEncoding("utf8")
    this.#socket.on("data", (chunk: string) => this.#receive(chunk))
    this.#socket.on("error", (error: NodeJS.ErrnoException) => this.#end(disconnectError(error)))
    this.#socket.on("close", () => this.#end(new Error("The local daemon disconnected")))
  }

  static async connect(
    onEvent: (event: DaemonEvent) => void,
    onDisconnect: (error: Error) => void,
    directory?: string,
  ): Promise<DaemonClient> {
    const discovery = await readDaemonDiscovery(directory)
    const client = new DaemonClient(discovery, onEvent, onDisconnect)
    try {
      client.info = await client.call("hello", { token: discovery.token })
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  call<M extends ControlMethod>(
    method: M,
    params: ControlMethods[M]["params"],
  ): Promise<ControlMethods[M]["result"]> {
    if (this.#closed) return Promise.reject(new Error("The local daemon disconnected"))
    const id = ++this.#nextId
    const line = `${JSON.stringify({ id, method, params })}\n`
    if (Buffer.byteLength(line) > MAX_CONTROL_MESSAGE_BYTES) {
      return Promise.reject(new Error("Daemon request is too large"))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // A timed-out mutation may still be running. Closing releases its peers.
        this.#end(new Error(`Daemon ${method} request timed out`))
      }, method === "workspaceSessionCreate" || method === "workspaceSessionDestroy" ? 120_000 : method === "providerTest" ? 60_000 : 15_000)
      this.#pending.set(id, {
        resolve: (value) => resolve(value as ControlMethods[M]["result"]),
        reject,
        timeout,
      })
      this.#socket.write(line)
    })
  }

  close(): void {
    this.#end(new Error("Desktop connection closed"))
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    let newline: number
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      // The authenticated daemon can return a catalog accumulated across many
      // bounded writes. The request size limit does not bound those snapshots.
      try {
        const message = JSON.parse(line) as ControlMessage
        if (!message || typeof message !== "object") throw new Error("Invalid daemon response")
        if ("event" in message) {
          this.#onEvent(message.event)
        } else {
          const pending = this.#pending.get(message.id)
          if (!pending) continue
          this.#pending.delete(message.id)
          clearTimeout(pending.timeout)
          if (typeof message.error === "string") {
            const error = new Error(message.error)
            if (message.reason === "encoder") (error as Error & { reason?: "encoder" }).reason = "encoder"
            pending.reject(error)
          } else pending.resolve(message.result)
        }
      } catch (error) {
        this.#end(error instanceof Error ? error : new Error("Invalid daemon response"))
        return
      }
    }
  }

  #end(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket.destroy()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#onDisconnect(error)
  }
}
