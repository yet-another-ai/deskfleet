import type { NativePeer, PeerEvent } from "@deskfleet/native"
import { desktopErrorReason } from "./control-protocol.ts"

export const DESKTOP_INPUT_CHANNEL = "deskfleet-input"
type DesktopPeer = Pick<NativePeer, "sendText" | "sendDesktopInput" | "setDesktopControl" | "setDesktopAudio">

/** Input belongs to a streaming peer and its selected display, never to signaling. */
export class DesktopInputChannel {
  #peer: DesktopPeer
  #authorizeStream: () => void
  #authorizeControl: () => void
  #started = false
  #enabled = false
  #draining = false
  #open = false
  #closed = false

  constructor(peer: DesktopPeer, authorizeStream: () => void, authorizeControl: () => void) {
    this.#peer = peer
    this.#authorizeStream = authorizeStream
    this.#authorizeControl = authorizeControl
  }

  async started(control: boolean): Promise<void> {
    if (this.#closed) throw new Error("Desktop input channel is closed")
    this.#authorizeStream()
    if (control) this.#authorizeControl()
    this.#started = true
    this.#enabled = control
    await this.#ready()
  }

  async #ready(): Promise<void> {
    if (this.#enabled && this.#open && !this.#closed) {
      this.#authorizeControl()
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
    if (!event.isString || !event.data || event.data.length > 4096) throw new Error("Invalid desktop input message")
    const text = event.data.toString("utf8")
    const message: unknown = JSON.parse(text)
    if (typeof message === "object" && message !== null && "type" in message && message.type === "configure") {
      await this.#configure(message as Record<string, unknown>)
      return
    }
    this.#authorizeStream()
    // Input queued before the disable acknowledgement must not end the video.
    if (!this.#enabled && this.#draining) return
    this.#authorizeControl()
    if (!this.#enabled) throw new Error("Desktop control is not enabled")
    // Native deserialization and validation precede injection; awaiting preserves key order.
    await this.#peer.sendDesktopInput(text)
  }

  async #configure(message: Record<string, unknown>): Promise<void> {
    const { requestId, audio, control } = message
    if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 0) throw new Error("Invalid desktop configuration request ID")
    try {
      this.#authorizeStream()
      if (!this.#started) throw new Error("Desktop stream has not started")
      if (typeof audio !== "boolean" || typeof control !== "boolean") throw new Error("Invalid desktop configuration")
      if (control) this.#authorizeControl()
      await this.#peer.setDesktopAudio(audio)
      this.#authorizeStream()
      if (control) this.#authorizeControl()
      // Native disabling removes the worker even if joining its cleanup fails.
      if (!control) { this.#enabled = false; this.#draining = true }
      await this.#peer.setDesktopControl(control)
      this.#enabled = control
      this.#draining = !control
    } catch (error) {
      const reason = desktopErrorReason(error)
      if (!this.#closed) await this.#peer.sendText(DESKTOP_INPUT_CHANNEL, JSON.stringify({
        type: "configurationError", requestId, control: this.#enabled,
        error: error instanceof Error ? error.message : String(error), ...(reason ? { reason } : {}),
      }))
      return
    }
    if (!this.#closed) await this.#peer.sendText(DESKTOP_INPUT_CHANNEL, JSON.stringify({ type: "configured", requestId, control: this.#enabled }))
  }

  close(): void { this.#closed = true }
}
