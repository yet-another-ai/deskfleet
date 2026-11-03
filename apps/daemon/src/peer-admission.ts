import type { ControlPeers } from "./control-server.ts"

const hosts = new WeakMap<ControlPeers, PeerAdmission>()

/** All registrations sharing a physical daemon share admission and replay capacity. */
export class PeerAdmission {
  #active = 0
  readonly #used = new Map<string, number>()

  static for(peers: ControlPeers): PeerAdmission {
    let admission = hosts.get(peers)
    if (!admission) { admission = new PeerAdmission(); hosts.set(peers, admission) }
    return admission
  }

  reserve(id: string, expires: number, now: number): () => void {
    for (const [used, deadline] of this.#used) if (deadline <= now) this.#used.delete(used)
    if (this.#used.has(id)) throw new Error("Create a new peer for another connection")
    if (this.#active >= 128 || this.#used.size >= 16_384) throw new Error("Daemon peer capacity exceeded")
    this.#used.set(id, expires)
    this.#active++
    let released = false
    return () => { if (!released) { released = true; this.#active-- } }
  }
}
