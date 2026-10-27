import { createPeer } from "@deskfleet/native"
import type { CentralApi } from "@deskfleet/client/central"
import type { PortForwardRequest } from "@deskfleet/client/ports"
import { connectPortPeer, type PortConnection, type PortPeerFactory } from "@deskfleet/client/ports-signaling"

/** The native listener and byte pump stay in main when the renderer goes away. */
export function createNativePortPeer(
  request: PortForwardRequest, signal: AbortSignal, options: { relayOnly?: boolean } = {},
): PortPeerFactory {
  return async (iceServers, events) => {
    const peer = await createPeer({ ...options, iceServers: iceServers.map(server => ({
      urls: typeof server.urls === "string" ? [server.urls] : server.urls,
      username: server.username, credential: server.credential,
    })) })
    let closing: Promise<void> | undefined
    const close = () => {
      signal.removeEventListener("abort", abort)
      return closing ??= peer.close()
    }
    const abort = () => { void close().catch(() => {}) }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) { await close(); throw new Error("Port forwarding was cancelled") }
    void (async () => {
      try {
        while (!closing) {
          const event = await peer.nextEvent()
          if (closing) return
          if (!event) { events.fail(new Error("Port forwarding peer closed")); return }
          if (event.kind === "iceCandidate" && event.candidate) events.candidate(event.candidate)
          else if (event.kind === "dataChannelOpen" && event.label === "deskfleet-ports") events.open()
          else if (event.kind === "error" || event.kind === "dataChannelClosed" || ["failed", "closed"].includes(event.state ?? "")) {
            events.fail(new Error(event.error ?? "Port forwarding peer closed")); return
          }
        }
      } catch (error) { if (!closing) events.fail(error instanceof Error ? error : new Error(String(error))) }
    })()
    try {
      const localPort = await peer.listenPortForward(request.localPort ?? 0, request.targetHost ?? "127.0.0.1", request.targetPort)
      return {
        localPort, close,
        offer: () => peer.createOffer(), answer: sdp => peer.acceptAnswer(sdp), candidate: value => peer.addIceCandidate(value),
      }
    } catch (error) { await close(); throw error }
  }
}

export function openNativePortForward(
  central: CentralApi, request: PortForwardRequest, failed: (error: Error) => void, signal: AbortSignal,
): Promise<PortConnection> {
  return connectPortPeer(central, request.target, createNativePortPeer(request, signal), failed, signal)
}
