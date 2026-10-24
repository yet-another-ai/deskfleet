import { AGENT_MESSAGE_BYTES } from "../../../../../daemon/src/agent-protocol.ts"

/** DataChannel messages are byte fragments, not JSON-RPC message boundaries. */
export class AgentMessageDecoder {
  readonly #receive: (message: unknown) => void
  #decoder = new TextDecoder("utf-8", { fatal: true })
  #parts: string[] = []
  #bytes = 0

  constructor(receive: (message: unknown) => void) { this.#receive = receive }

  write(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset)
      const part = bytes.subarray(offset, end === -1 ? bytes.length : end)
      this.#bytes += part.length
      if (this.#bytes > AGENT_MESSAGE_BYTES) throw new Error("Agent message exceeds the 32 MiB limit")
      this.#parts.push(this.#decoder.decode(part, { stream: true }))
      if (end === -1) return
      this.#parts.push(this.#decoder.decode())
      const line = this.#parts.join("")
      this.#parts = []
      this.#bytes = 0
      if (line.trim()) this.#receive(JSON.parse(line))
      offset = end + 1
    }
  }
}
