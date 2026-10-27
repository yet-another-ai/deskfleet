import { randomUUID } from "node:crypto"
import type { CentralApi } from "@deskfleet/client/central"
import type { PortForward, PortForwardRequest, PortsApi } from "@deskfleet/client/ports"
import type { PortConnection } from "@deskfleet/client/ports-signaling"

export type OpenPortForward = (
  request: PortForwardRequest, failed: (error: Error) => void, signal: AbortSignal,
) => Promise<PortConnection>
interface OwnedForward {
  abort: AbortController
  pending: Promise<PortConnection>
  value?: PortForward
  closing?: Promise<void>
}

/** App-owned listeners survive window navigation and close on account changes. */
export class PortForwards implements PortsApi {
  readonly #open: OpenPortForward
  readonly #entries = new Map<string, OwnedForward>()
  readonly #closing = new Set<Promise<void>>()
  readonly #unsubscribe: () => void
  #closed = false

  constructor(central: Pick<CentralApi, "onEvent">, open: OpenPortForward) {
    this.#open = open
    this.#unsubscribe = central.onEvent(event => {
      if (event.type === "accountChanged") void this.#clear().catch(error => console.error("Port forwarding cleanup failed", error))
    })
  }

  async start(request: PortForwardRequest): Promise<PortForward> {
    if (this.#closed) throw new Error("Port forwarding is closed")
    const id = randomUUID()
    // Copy caller-owned values before negotiation yields.
    const options = { ...request, target: { ...request.target } }
    // Defer the connector so even a synchronous failure can retire this entry.
    const entry: OwnedForward = {
      abort: new AbortController(),
      pending: Promise.resolve().then(() => this.#open(options, () => {
        void this.#retire(id, entry).catch(error => console.error("Port forwarding cleanup failed", error))
      }, entry.abort.signal)),
    }
    this.#entries.set(id, entry)
    try {
      const connection = await entry.pending
      if (this.#entries.get(id) !== entry) throw new Error("Port forwarding was cancelled")
      entry.value = {
        id, target: options.target, localHost: "127.0.0.1", localPort: connection.localPort,
        targetHost: options.targetHost ?? "127.0.0.1", targetPort: options.targetPort,
      }
      return this.#snapshot(entry.value)
    } catch (error) {
      await this.#retire(id, entry)
      throw error
    }
  }

  async list(): Promise<PortForward[]> {
    return [...this.#entries.values()].flatMap(entry => entry.value ? [this.#snapshot(entry.value)] : [])
  }

  async stop(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (entry) await this.#retire(id, entry)
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#clear()
    this.#closed = true
    this.#unsubscribe()
    await this.#clear()
  }

  #snapshot(value: PortForward): PortForward { return { ...value, target: { ...value.target } } }

  #retire(id: string, entry: OwnedForward): Promise<void> {
    if (entry.closing) return entry.closing
    this.#entries.delete(id)
    // Aborting signaling synchronously calls its failure callback. Publish the
    // cleanup first so that callback joins this retirement instead of starting another.
    const closing = Promise.resolve().then(async () => {
      const connection = await entry.pending.catch(() => undefined)
      await connection?.close()
    })
    entry.closing = closing
    this.#closing.add(closing)
    void closing.finally(() => { this.#closing.delete(closing) }).catch(() => {})
    entry.abort.abort()
    return closing
  }

  async #clear(): Promise<void> {
    for (const [id, entry] of this.#entries) this.#retire(id, entry)
    const results = await Promise.allSettled(this.#closing)
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Failed to close port forwarding")
  }
}
