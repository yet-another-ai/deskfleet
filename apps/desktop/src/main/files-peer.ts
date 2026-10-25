import { createPeer } from "@deskfleet/native"
import type { CentralApi } from "@deskfleet/client/central"
import { FilesRpcClient } from "@deskfleet/client/files-rpc"
import { connectFilePeer, type FilePeerFactory, type MachineFileTarget } from "@deskfleet/client/files-signaling"
import { FILES_CHANNEL } from "../../../../apps/daemon/src/files-protocol.ts"

const nativePeer: FilePeerFactory = async (iceServers, events) => {
  const peer = await createPeer({ iceServers: iceServers.map(server => ({
    urls: typeof server.urls === "string" ? [server.urls] : server.urls,
    username: server.username, credential: server.credential,
  })) })
  let closed = false
  const stopping = new AbortController()
  const waitForCapacity = () => new Promise<void>((resolve, reject) => {
    const ready = () => { stopping.signal.removeEventListener("abort", stop); resolve() }
    const timer = setTimeout(ready, 10)
    const stop = () => { clearTimeout(timer); stopping.signal.removeEventListener("abort", stop); reject(new Error("File peer closed")) }
    stopping.signal.addEventListener("abort", stop, { once: true })
    if (closed) stop()
  })
  void (async () => {
    try {
      while (!closed) {
        const event = await peer.nextEvent()
        if (closed) return
        if (!event) { events.fail(new Error("File peer closed")); return }
        if (event.kind === "data" && event.label === FILES_CHANNEL && event.data) {
          if (event.isString) throw new Error("File DataChannel requires binary frames")
          events.data(event.data)
        } else if (event.kind === "iceCandidate" && event.candidate) events.candidate(event.candidate)
        else if (event.kind === "dataChannelOpen" && event.label === FILES_CHANNEL) events.open()
        else if (event.kind === "error" || event.kind === "dataChannelClosed" || ["failed", "closed"].includes(event.state ?? "")) {
          events.fail(new Error(event.error ?? "File peer closed")); return
        }
      }
    } catch (error) { if (!closed) events.fail(error instanceof Error ? error : new Error(String(error))) }
  })()
  try { await peer.createDataChannel(FILES_CHANNEL) }
  catch (error) { closed = true; await peer.close(); throw error }
  return {
    offer: () => peer.createOffer(), answer: sdp => peer.acceptAnswer(sdp), candidate: value => peer.addIceCandidate(value),
    async send(bytes) {
      const data = Buffer.from(bytes), deadline = Date.now() + 5_000
      for (;;) {
        if (closed) throw new Error("File peer closed")
        try { await peer.sendData(FILES_CHANNEL, data); return }
        catch (error) {
          if (!/backpressure|send buffer is full/iu.test(error instanceof Error ? error.message : String(error))) throw error
          if (Date.now() >= deadline) throw new Error("File send buffer stalled", { cause: error })
        }
        await waitForCapacity()
      }
    },
    async close() { if (closed) return; closed = true; stopping.abort(); await peer.close() },
  }
}

/** Runs in Electron main so a hidden/destroyed renderer does not own transfers. */
export function createNativeFileEndpoint(central: CentralApi, target: MachineFileTarget): FilesRpcClient {
  return new FilesRpcClient((receive, failed) => connectFilePeer(central, target, nativePeer, receive, failed))
}
