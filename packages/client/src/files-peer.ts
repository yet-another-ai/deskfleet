import { FILES_CHANNEL } from "../../../apps/daemon/src/files-protocol.ts"
import { FILE_WIRE_CHUNK_BYTES } from "../../../apps/daemon/src/files-wire.ts"
import type { CentralApi } from "./central.ts"
import { FilesRpcClient } from "./files-rpc.ts"
import { connectFilePeer, type FilePeerFactory, type MachineFileTarget } from "./files-signaling.ts"

const browserPeer: FilePeerFactory = async (iceServers, events) => {
  const peer = new RTCPeerConnection({ iceServers })
  const channel = peer.createDataChannel(FILES_CHANNEL, { ordered: true })
  channel.binaryType = "arraybuffer"
  channel.bufferedAmountLowThreshold = 64 * 1024
  let closed = false
  const failed = () => { if (!closed) events.fail(new Error("File DataChannel closed")) }
  channel.onopen = () => events.open()
  channel.onclose = failed; channel.onerror = failed
  channel.onmessage = ({ data }) => {
    if (!(data instanceof ArrayBuffer)) { events.fail(new Error("File DataChannel requires binary frames")); return }
    events.data(new Uint8Array(data))
  }
  peer.onconnectionstatechange = () => { if (["failed", "closed"].includes(peer.connectionState)) failed() }
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || closed) return
    const value = candidate.toJSON()
    events.candidate({ candidate: value.candidate ?? "", sdpMid: value.sdpMid ?? undefined, sdpMlineIndex: value.sdpMLineIndex ?? undefined, usernameFragment: value.usernameFragment ?? undefined })
  }
  function capacity(): Promise<void> {
    if (channel.readyState !== "open") return Promise.reject(new Error("File DataChannel is not open"))
    if (channel.bufferedAmount <= 256 * 1024) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout); channel.removeEventListener("bufferedamountlow", done)
        channel.removeEventListener("close", lost); channel.removeEventListener("error", lost)
      }
      const done = () => { cleanup(); resolve() }
      const lost = () => { cleanup(); reject(new Error("File send interrupted")) }
      const timeout = setTimeout(lost, 30_000)
      channel.addEventListener("bufferedamountlow", done, { once: true })
      channel.addEventListener("close", lost, { once: true }); channel.addEventListener("error", lost, { once: true })
      if (channel.readyState !== "open") lost()
      else if (channel.bufferedAmount <= 64 * 1024) done()
    })
  }
  return {
    async offer() { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); return offer.sdp! },
    async answer(sdp) { await peer.setRemoteDescription({ type: "answer", sdp }) },
    async candidate(value) { await peer.addIceCandidate({ candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMlineIndex, usernameFragment: value.usernameFragment }) },
    async send(bytes) {
      const negotiated = peer.sctp?.maxMessageSize
      const size = negotiated && Number.isFinite(negotiated) ? Math.min(FILE_WIRE_CHUNK_BYTES, negotiated) : FILE_WIRE_CHUNK_BYTES
      for (let offset = 0; offset < bytes.length; offset += size) {
        await capacity(); channel.send(bytes.slice(offset, offset + size))
      }
    },
    async close() { closed = true; channel.close(); peer.close() },
  }
}

export function createBrowserFileEndpoint(central: CentralApi, target: MachineFileTarget): FilesRpcClient {
  return new FilesRpcClient((receive, failed) => connectFilePeer(central, target, browserPeer, receive, failed))
}
