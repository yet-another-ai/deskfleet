import { randomUUID } from "node:crypto"
import type { Notice } from "@agentclientprotocol/sdk/unstable"
import type { AgentAuthStatus, AgentLiveUpdate } from "../../../packages/client/src/agent-live.ts"

/** Registration-local live state. Notices are delivered once; only current auth is retained. */
export class AgentLiveState {
  readonly #listeners = new Set<(update: AgentLiveUpdate) => void>()
  readonly #auth = new Map<string, AgentLiveUpdate & { kind: "auth" }>()

  onUpdate(listener: (update: AgentLiveUpdate) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  current(sessionId: string): AgentLiveUpdate | undefined { return this.#auth.get(sessionId) }

  auth(sessionId: string, runGeneration: number, auth: AgentAuthStatus | null): void {
    const update: AgentLiveUpdate & { kind: "auth" } = { sessionId, runGeneration, kind: "auth", auth }
    if (auth) this.#auth.set(sessionId, update)
    else this.#auth.delete(sessionId)
    this.#emit(update)
  }

  notice(sessionId: string, runGeneration: number, providerSessionId: string, notice: Notice): void {
    this.#emit({ sessionId, runGeneration, kind: "notice", notice: {
      id: randomUUID(), providerSessionId, severity: notice.severity, title: notice.title,
      ...(notice.description != null ? { description: notice.description } : {}),
    } })
  }

  #emit(update: AgentLiveUpdate): void {
    for (const listener of this.#listeners) listener(update)
  }
}
