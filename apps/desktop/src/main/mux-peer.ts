import { createPeer } from "@deskfleet/native"
import type { MuxPeerFactory } from "@deskfleet/client/mux-client"
import { MUX_LABELS, type MuxLane } from "@deskfleet/client/mux/protocol"

const lanes = new Map<string, MuxLane>(Object.entries(MUX_LABELS).map(([lane, label]) => [label, lane as MuxLane]))

/** Main owns one native peer for all remote data consumers in the same authenticated scope. */
export async function nativeMuxPeer(
  iceServers: Parameters<MuxPeerFactory>[0], events: Parameters<MuxPeerFactory>[1], options: { relayOnly?: boolean } = {},
): ReturnType<MuxPeerFactory> {
  const peer = await createPeer({ ...options, iceServers: iceServers.map(server => ({
    urls: typeof server.urls === "string" ? [server.urls] : server.urls,
    username: server.username, credential: server.credential,
  })) })
  let closed = false
  const stopping = new AbortController()
  const close = async () => {
    if (closed) return
    closed = true
    stopping.abort()
    await peer.close()
  }
  const capacity = () => new Promise<void>((resolve, reject) => {
    const ready = () => { stopping.signal.removeEventListener("abort", stop); resolve() }
    const timer = setTimeout(ready, 10)
    const stop = () => { clearTimeout(timer); reject(new Error("Mux peer closed")) }
    stopping.signal.addEventListener("abort", stop, { once: true })
    if (closed) stop()
  })
  void (async () => {
    try {
      while (!closed) {
        const event = await peer.nextEvent()
        if (closed) return
        if (!event) throw new Error("Mux peer closed")
        if (event.kind === "data" && event.data) {
          const lane = lanes.get(event.label ?? "")
          if (!lane || event.isString) throw new Error("Mux peer received an invalid data channel frame")
          events.data(lane, event.data)
        } else if (event.kind === "dataChannelOpen") {
          const lane = lanes.get(event.label ?? "")
          if (!lane) throw new Error("Mux peer opened an unknown data channel")
          events.open(lane)
        } else if (event.kind === "iceCandidate" && event.candidate) events.candidate(event.candidate)
        else if (event.kind === "stateChanged" && event.state) events.state(event.state)
        else if (event.kind === "error" || event.kind === "dataChannelClosed") throw new Error(event.error ?? "Mux data channel closed")
      }
    } catch (error) { if (!closed) events.fail(error instanceof Error ? error : new Error(String(error))) }
  })()
  try {
    for (const label of Object.values(MUX_LABELS)) await peer.createDataChannel(label)
  } catch (error) { await close(); throw error }
  return {
    offer: () => peer.createOffer(), answer: sdp => peer.acceptAnswer(sdp), candidate: value => peer.addIceCandidate(value),
    async send(lane, bytes) {
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), deadline = Date.now() + 5_000
      for (;;) {
        if (closed) throw new Error("Mux peer closed")
        try { await peer.sendData(MUX_LABELS[lane], data); return }
        catch (error) {
          if (!/backpressure|send buffer is full/iu.test(error instanceof Error ? error.message : String(error))) throw error
          if (Date.now() >= deadline) throw new Error("Mux send buffer stalled", { cause: error })
        }
        await capacity()
      }
    },
    close,
  }
}
