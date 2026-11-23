import { createPeer, type NativePeer, type PeerConfig } from "@deskfleet/native"

/** Daemon-owned transports. The authenticated signaling layer supplies session IDs. */
export class PeerSessions {
  #peers = new Map<string, Promise<NativePeer>>()
  #closed = false

  async create(id: string, config: PeerConfig = {}): Promise<NativePeer> {
    if (this.#closed) throw new Error("Peer sessions are closed")
    if (!id) throw new Error("Peer session ID must not be empty")
    if (this.#peers.has(id)) throw new Error(`Peer session already exists: ${id}`)
    if (this.#peers.size >= 128) throw new Error("Native peer capacity exceeded")
    const pending = createPeer(config)
    this.#peers.set(id, pending)
    try {
      return await pending
    } catch (error) {
      if (this.#peers.get(id) === pending) this.#peers.delete(id)
      throw error
    }
  }

  async close(id: string): Promise<void> {
    const pending = this.#peers.get(id)
    if (!pending) return
    try {
      const peer = await pending
      await peer.close()
    } finally {
      if (this.#peers.get(id) === pending) this.#peers.delete(id)
    }
  }

  async closeAll(): Promise<void> {
    this.#closed = true
    const results = await Promise.allSettled([...this.#peers.keys()].map(id => this.close(id)))
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Failed to close peer sessions")
  }
}
