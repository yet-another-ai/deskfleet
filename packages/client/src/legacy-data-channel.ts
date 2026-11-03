import type { AgentSignalingApi } from "./agent.ts"
import type { IceCandidate } from "./desktop-media.ts"
import { DataChannelErrorEvent, type DataChannel } from "./data-channel.ts"
import { createPeerDisconnectGuard, PEER_SETUP_TIMEOUT_MS } from "./peer-lifecycle.ts"
import { relayFailureError } from "./relay.ts"

/** Used only when a previously advertised Mux capability is explicitly unsupported. */
export async function legacyDataChannel(api: AgentSignalingApi, purpose: "agent" | "terminal", id: string): Promise<DataChannel> {
  const iceServers = await api.prepare?.(id) ?? []
  let peer: RTCPeerConnection
  try { peer = new RTCPeerConnection({ iceServers }) }
  catch (error) { await api.close(id); throw error }
  const channel = peer.createDataChannel(purpose === "agent" ? "deskfleet-acp" : "deskfleet-terminal", { ordered: true })
  let closed = false, offered = false, remoteReady = false, sending = Promise.resolve(), adding = Promise.resolve()
  const local: IceCandidate[] = [], remote: IceCandidate[] = []
  const disconnects = createPeerDisconnectGuard(() => fail(new Error("Peer disconnected"), true))
  const timer = setTimeout(() => fail(new Error("Peer setup timed out"), true), PEER_SETUP_TIMEOUT_MS)
  const cleanup = () => {
    if (closed) return
    closed = true; clearTimeout(timer); disconnects.clear(); unsubscribe(); peer.close()
    void api.close(id).catch(() => {})
  }
  function fail(error: Error, transport = false): void {
    if (closed) return
    channel.dispatchEvent(new DataChannelErrorEvent(transport ? relayFailureError(api.connectionFailureReason?.(id), error) : error))
    channel.close(); cleanup()
  }
  function state(value: string): void {
    if (["failed", "closed"].includes(value.toLowerCase())) fail(new Error("Peer connection lost"), true)
    else disconnects.update(value)
  }
  function flush(): void {
    if (offered) {
      const values = local.splice(0)
      sending = sending.then(async () => { for (const value of values) { if (closed) return; await api.candidate(id, value) } }).catch(fail)
    }
    if (remoteReady) {
      const values = remote.splice(0)
      adding = adding.then(async () => {
        for (const value of values) {
          if (closed) return
          await peer.addIceCandidate({ candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMlineIndex, usernameFragment: value.usernameFragment })
        }
      }).catch(fail)
    }
  }
  const unsubscribe = api.onEvent(event => {
    if (event.sessionId !== id || closed) return
    if (event.kind === "iceCandidate") { remote.push(event.candidate); flush() }
    else if (event.kind === "error") fail(new Error(event.error))
    else state(event.state)
  })
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate || closed) return
    const value = candidate.toJSON()
    local.push({ candidate: value.candidate ?? "", sdpMid: value.sdpMid ?? undefined, sdpMlineIndex: value.sdpMLineIndex ?? undefined, usernameFragment: value.usernameFragment ?? undefined })
    flush()
  }
  peer.onconnectionstatechange = () => state(peer.connectionState)
  channel.addEventListener("close", cleanup, { once: true })
  channel.addEventListener("open", () => clearTimeout(timer), { once: true })
  // Callers install handlers before the SDP exchange can open or fail the channel.
  void Promise.resolve().then(async () => {
    const offer = await peer.createOffer()
    if (closed) return
    await peer.setLocalDescription(offer)
    if (closed) return
    const answer = await api.offer({ sessionId: id, sdp: offer.sdp! })
    if (closed) return
    offered = true; flush()
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    remoteReady = true; flush()
  }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  return channel
}
