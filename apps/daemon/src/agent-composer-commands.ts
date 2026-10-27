import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable"

/** ACP command notifications may arrive just after session/new or session/load. */
export class AgentComposerCommands {
  current?: AvailableCommand[]
  readonly #controller = new AbortController()
  readonly #listeners = new Set<() => void>()

  update(commands: AvailableCommand[]): void {
    if (this.#controller.signal.aborted) return
    this.current = commands
    for (const listener of this.#listeners) listener()
  }

  async ready(signal?: AbortSignal, timeoutMs = 1_000): Promise<void> {
    signal?.throwIfAborted()
    if (this.current !== undefined) return
    const combined = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal
    combined.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(combined.reason) }
      const timer = setTimeout(finish, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.#listeners.delete(finish)
        combined.removeEventListener("abort", abort)
      }
      this.#listeners.add(finish)
      combined.addEventListener("abort", abort, { once: true })
    })
  }

  close(): void {
    this.#controller.abort(new Error("Agent command discovery was stopped"))
  }
}
