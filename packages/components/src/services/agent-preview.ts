import type { AgentEvent, AgentPreview } from "../../../../apps/daemon/src/agent-protocol.ts"

interface PreviewStream { id: string; base: bigint; events: AgentEvent[] }

/** Volatile display tails never become history cursors or durable journal entries. */
export class AgentPreviews {
  readonly #streams = new Map<string, PreviewStream>()

  receive(preview: AgentPreview): boolean {
    let stream = this.#streams.get(preview.sessionId)
    if (stream?.id !== preview.streamId) {
      if (preview.offset !== 0) throw new Error("Agent preview is missing its beginning")
      stream = { id: preview.streamId, base: BigInt(preview.baseSeq), events: [] }
      this.#streams.set(preview.sessionId, stream)
    }
    if (preview.offset > stream.events.length) throw new Error("Agent preview has a missing fragment")
    const additions = preview.events.slice(Math.max(0, stream.events.length - preview.offset))
    for (const event of additions) stream.events.push({ ...event, seq: String(stream.base + BigInt(stream.events.length) + 1n) })
    return additions.length > 0
  }

  has(id: string): boolean { return this.#streams.has(id) }
  ids(): string[] { return [...this.#streams.keys()] }
  delete(id: string): void { this.#streams.delete(id) }

  after(id: string, sequence: string): AgentEvent[] {
    const stream = this.#streams.get(id)
    if (!stream) return []
    const offset = BigInt(sequence) - stream.base
    return offset >= BigInt(stream.events.length) ? [] : stream.events.slice(Number(offset > 0n ? offset : 0n))
  }

  committed(id: string, through: string): void {
    const stream = this.#streams.get(id)
    if (stream && BigInt(through) >= stream.base + BigInt(stream.events.length)) this.#streams.delete(id)
  }
}
