import type { IceCandidate } from "./desktop-media.ts"
import { MUX_LABELS, type MuxLane } from "./mux/protocol.ts"

export interface MuxPeerEvents {
  data(lane: MuxLane, bytes: Uint8Array): void
  open(lane: MuxLane): void
  candidate(value: IceCandidate): void
  state(value: string): void
  fail(error: Error): void
}
export interface MuxPeer {
  offer(): Promise<string>
  answer(sdp: string): Promise<void>
  candidate(value: IceCandidate): Promise<void>
  send(lane: MuxLane, bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}
export type MuxPeerFactory = (iceServers: RTCIceServer[], events: MuxPeerEvents) => Promise<MuxPeer>

/** All four SCTP streams join the initial negotiation; tasks only open logical streams. */
export const browserMuxPeer: MuxPeerFactory = async (iceServers, events) => {
  const peer = new RTCPeerConnection({ iceServers })
  const channels = new Map<MuxLane, RTCDataChannel>()
  let closed = false
  const stop = new AbortController()
  const failed = () => { if (!closed) events.fail(new Error("Machine data channel closed")) }
  try {
    for (const lane of Object.keys(MUX_LABELS) as MuxLane[]) {
      const channel = peer.createDataChannel(MUX_LABELS[lane], { ordered: true })
      channels.set(lane, channel)
      channel.binaryType = "arraybuffer"
      channel.bufferedAmountLowThreshold = 16 * 1024
      channel.onopen = () => events.open(lane)
      channel.onclose = failed; channel.onerror = failed
      channel.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) { events.fail(new Error("Mux requires binary frames")); return }
        events.data(lane, new Uint8Array(data))
      }
    }
  } catch (error) { peer.close(); throw error }
  peer.onconnectionstatechange = () => { if (!closed) events.state(peer.connectionState) }
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || closed) return
    const value = candidate.toJSON()
    events.candidate({ candidate: value.candidate ?? "", sdpMid: value.sdpMid ?? undefined,
      sdpMlineIndex: value.sdpMLineIndex ?? undefined, usernameFragment: value.usernameFragment ?? undefined })
  }
  function capacity(channel: RTCDataChannel): Promise<void> {
    if (closed || channel.readyState !== "open") return Promise.reject(new Error("Mux connection closed"))
    // Keep the transport queue shallow so a bulk producer cannot fill the association.
    if (channel.bufferedAmount <= 32 * 1024) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); channel.removeEventListener("bufferedamountlow", ready)
        stop.signal.removeEventListener("abort", lost)
      }
      const ready = () => { cleanup(); resolve() }
      const lost = () => { cleanup(); reject(new Error("Mux send interrupted")) }
      const timer = setTimeout(lost, 5_000)
      channel.addEventListener("bufferedamountlow", ready, { once: true })
      stop.signal.addEventListener("abort", lost, { once: true })
      if (closed || channel.readyState !== "open") lost()
      else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready()
    })
  }
  return {
    async offer() { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); return offer.sdp! },
    async answer(sdp) { await peer.setRemoteDescription({ type: "answer", sdp }) },
    async candidate(value) { await peer.addIceCandidate({ candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMlineIndex, usernameFragment: value.usernameFragment }) },
    async send(lane, bytes) { const channel = channels.get(lane)!; await capacity(channel); channel.send(bytes.slice()) },
    async close() {
      if (closed) return
      closed = true; stop.abort()
      for (const channel of channels.values()) channel.close()
      peer.close()
    },
  }
}
