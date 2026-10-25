import type { NativePeer, PeerEvent } from "@deskfleet/native"

export const DESKTOP_INPUT_CHANNEL = "deskfleet-input"

/** Input belongs to a streaming peer and its selected display, never to signaling. */
export class DesktopInputChannel {
  #peer: Pick<NativePeer, "sendText" | "sendDesktopInput">
  #authorize: () => void
  #enabled = false
  #open = false
  #closed = false

  constructor(peer: Pick<NativePeer, "sendText" | "sendDesktopInput">, authorize: () => void) {
    this.#peer = peer
    this.#authorize = authorize
  }

  async enable(): Promise<void> {
    if (this.#closed) throw new Error("Desktop input channel is closed")
    this.#authorize()
    this.#enabled = true
    await this.#ready()
  }

  async #ready(): Promise<void> {
    if (this.#enabled && this.#open && !this.#closed) {
      this.#authorize()
      await this.#peer.sendText(DESKTOP_INPUT_CHANNEL, JSON.stringify({ type: "ready" }))
    }
  }

  async receive(event: PeerEvent): Promise<void> {
    if (this.#closed) return
    if (event.kind === "stateChanged" && event.state === "disconnected" && this.#enabled) {
      await this.#peer.sendDesktopInput(JSON.stringify({ type: "releaseAll" }))
    }
    if (event.label !== DESKTOP_INPUT_CHANNEL) return
    if (event.kind === "dataChannelOpen") { this.#open = true; await this.#ready() }
    if (event.kind !== "data") return
    this.#authorize()
    if (!this.#enabled) throw new Error("Desktop control is not enabled")
    if (!event.isString || !event.data || event.data.length > 4096) throw new Error("Invalid desktop input message")
    // Native deserialization and validation precede injection; awaiting preserves key order.
    await this.#peer.sendDesktopInput(event.data.toString("utf8"))
  }

  close(): void { this.#closed = true }
}
