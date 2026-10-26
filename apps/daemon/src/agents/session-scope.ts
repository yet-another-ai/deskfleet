import { RequestError } from "@agentclientprotocol/sdk/unstable"

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !sessionId.length) {
    throw RequestError.invalidParams({ details: "ACP session ID must be a nonempty string" })
  }
}

/** Binds client callbacks to the session currently owned by this provider connection. */
export class AcpSessionScope {
  #active?: string
  #opening?: { sessionId?: string }

  begin(expectedId?: string): void {
    if (this.#opening) throw new Error("An ACP session is already opening")
    if (expectedId !== undefined) requireSessionId(expectedId)
    this.#opening = { sessionId: expectedId }
  }

  require(sessionId: string): void {
    requireSessionId(sessionId)
    if (this.#opening) {
      // Agents can await a client callback before returning session/new or fork.
      // Bind its first ID now and verify it against the eventual response.
      this.#opening.sessionId ??= sessionId
      if (this.#opening.sessionId === sessionId) return
    } else if (this.#active === sessionId) {
      return
    }
    throw RequestError.invalidParams({ details: "ACP request does not belong to the current session" })
  }

  complete(sessionId: string): void {
    const opening = this.#opening
    this.#opening = undefined
    if (!opening) throw new Error("No ACP session is opening")
    requireSessionId(sessionId)
    if (opening.sessionId !== undefined && opening.sessionId !== sessionId) {
      throw RequestError.invalidParams({ details: "ACP session response does not match its client callbacks" })
    }
    this.#active = sessionId
  }

  /** Failed replacement keeps the previous active session and discards provisional IDs. */
  fail(): void {
    this.#opening = undefined
  }

  clear(): void {
    this.#active = undefined
    this.#opening = undefined
  }
}
