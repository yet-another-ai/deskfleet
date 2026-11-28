import type { NativeCatalog } from "@deskfleet/native"

/** The registration owns one connection. Each edit commits its full ledger before callers can dispatch. */
export class LocalSuperStore<T> {
  readonly #catalog: Pick<NativeCatalog, "superAgentStates" | "saveSuperAgentState">
  readonly #rows = new Map<string, { revision: number; value: T }>()
  #pending: Promise<void> = Promise.resolve()

  constructor(catalog: Pick<NativeCatalog, "superAgentStates" | "saveSuperAgentState">) { this.#catalog = catalog }
  async init(): Promise<void> {
    for (const row of await this.#catalog.superAgentStates()) {
      this.#rows.set(row.userId, { revision: row.revision, value: JSON.parse(row.stateJson) as T })
    }
  }
  get(userId: string): T | undefined { return structuredClone(this.#rows.get(userId)?.value) }
  users(): string[] { return [...this.#rows.keys()] }
  update<R>(userId: string, initial: () => T, edit: (state: T) => R): Promise<R> {
    const next = this.#pending.then(async () => {
      const row = this.#rows.get(userId)
      const revision = row?.revision ?? 0
      const state = row ? structuredClone(row.value) : initial()
      const result = edit(state)
      await this.#catalog.saveSuperAgentState(userId, revision, JSON.stringify(state))
      this.#rows.set(userId, { revision: revision + 1, value: state })
      return structuredClone(result)
    })
    this.#pending = next.then(() => {}, () => {})
    return next
  }
  close(): Promise<void> { return this.#pending }
}
