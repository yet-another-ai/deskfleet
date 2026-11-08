import { RequestError } from "@agentclientprotocol/sdk/unstable"
import { isAbsolute } from "node:path"
import type { SubagentUpdate } from "@agentclientprotocol/sdk/unstable"

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !sessionId.length) {
    throw RequestError.invalidParams({ details: "ACP session ID must be a nonempty string" })
  }
}

/** Binds client callbacks to the session currently owned by this provider connection. */
export class AcpSessionScope {
  #active?: string
  #children = new Map<string, { parent: string; cwd?: string }>()
  #opening?: {
    sessionId?: string
    children: Map<string, { parent: string; cwd?: string }>
    replayedChildren: Map<string, SubagentUpdate[]>
  }

  begin(expectedId?: string): void {
    if (this.#opening) throw new Error("An ACP session is already opening")
    if (expectedId !== undefined) requireSessionId(expectedId)
    this.#opening = { sessionId: expectedId, children: new Map(), replayedChildren: new Map() }
  }

  require(sessionId: string): void {
    requireSessionId(sessionId)
    if (this.#opening) {
      // Agents can await a client callback before returning session/new or fork.
      // Bind its first ID now and verify it against the eventual response.
      if (this.#opening.children.has(sessionId)) return
      this.#opening.sessionId ??= sessionId
      if (this.#opening.sessionId === sessionId) return
    } else if (this.#active === sessionId || this.#children.has(sessionId)) {
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
    this.#children = opening.children
  }

  isRoot(sessionId: string): boolean {
    return sessionId === (this.#opening?.sessionId ?? this.#active)
  }

  /** Only a known immediate parent may announce a child, before its callbacks. */
  associate(parent: string, child: SubagentUpdate): void {
    this.require(parent)
    requireSessionId(child.sessionId)
    const children = this.#opening?.children ?? this.#children
    const previous = children.get(child.sessionId)
    if (child.sessionId === parent || this.isRoot(child.sessionId) || previous && previous.parent !== parent) {
      throw RequestError.invalidParams({ details: "ACP child session ownership cannot change" })
    }
    if (child.cwd != null && !isAbsolute(child.cwd)) {
      throw RequestError.invalidParams({ details: "ACP child working directory must be absolute" })
    }
    children.set(child.sessionId, { parent,
      ...(child.cwd === undefined ? previous?.cwd ? { cwd: previous.cwd } : {} : child.cwd === null ? {} : { cwd: child.cwd }),
    })
  }

  /** Historical declarations may arrive out of order; only a path to the loading root grants access. */
  restore(parent: string, child: SubagentUpdate): string[] {
    const opening = this.#opening
    if (!opening?.sessionId) throw new Error("ACP child history requires a known loading session")
    requireSessionId(parent)
    requireSessionId(child.sessionId)
    if (parent !== opening.sessionId && !opening.children.has(parent)) {
      const pending = opening.replayedChildren.get(parent) ?? []
      pending.push(child)
      opening.replayedChildren.set(parent, pending)
      return []
    }
    const restored: string[] = []
    const ready = [{ parent, child }]
    for (const entry of ready) {
      const known = opening.children.has(entry.child.sessionId)
      this.associate(entry.parent, entry.child)
      if (!known) restored.push(entry.child.sessionId)
      const pending = opening.replayedChildren.get(entry.child.sessionId) ?? []
      opening.replayedChildren.delete(entry.child.sessionId)
      for (const child of pending) ready.push({ parent: entry.child.sessionId, child })
    }
    // Unconnected declarations remain provisional and are discarded by complete/fail.
    return restored
  }

  cwd(sessionId: string): string | undefined {
    this.require(sessionId)
    const children = this.#opening?.children ?? this.#children
    const child = children.get(sessionId)
    return child?.cwd ?? (child ? this.cwd(child.parent) : undefined)
  }

  /** Failed replacement keeps the previous active session and discards provisional IDs. */
  fail(): void {
    this.#opening = undefined
  }

  clear(): void {
    this.#active = undefined
    this.#children.clear()
    this.#opening = undefined
  }
}
