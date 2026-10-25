import { withBase } from "vitepress"
import type { DesktopEvent, DesktopMediaApi } from "@deskfleet/client/desktop-media"

interface PreviewPeer {
  peer: RTCPeerConnection
  stream: MediaStream
  timer: ReturnType<typeof setInterval>
}
const peers = new Map<string, PreviewPeer>()
const listeners = new Set<(event: DesktopEvent) => void>()

/** A recorded product screen supplies media to the real DesktopView over local WebRTC. */
export const desktopPreview: DesktopMediaApi = {
  target: async () => ({ id: "demo-machine", name: "Studio Mac", online: true, desktop: true }),
  capabilities: async () => ({
    displays: [{ id: 1, width: 1280, height: 800, refreshRateHz: 30, codecs: ["h264", "av1"] }],
    audio: false,
  }),
  async offer({ sessionId, sdp }) {
    const source = new Image()
    source.src = withBase(`/demo-desktop-${document.documentElement.classList.contains("dark") ? "dark" : "light"}.png`)
    await source.decode()
    const canvas = document.createElement("canvas")
    canvas.width = source.naturalWidth
    canvas.height = source.naturalHeight
    const context = canvas.getContext("2d")!
    const draw = () => context.drawImage(source, 0, 0)
    draw()
    const stream = canvas.captureStream(5)
    for (const track of stream.getVideoTracks()) track.contentHint = "detail"
    const peer = new RTCPeerConnection({ iceServers: [] })
    const preview = { peer, stream, timer: setInterval(draw, 200) }
    peers.set(sessionId, preview)
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      const event: DesktopEvent = { sessionId, kind: "iceCandidate", candidate: {
        candidate: candidate.candidate,
        ...(candidate.sdpMid !== null ? { sdpMid: candidate.sdpMid } : {}),
        ...(candidate.sdpMLineIndex !== null ? { sdpMlineIndex: candidate.sdpMLineIndex } : {}),
        ...(candidate.usernameFragment !== null ? { usernameFragment: candidate.usernameFragment } : {}),
      } }
      for (const listener of listeners) listener(event)
    }
    try {
      await peer.setRemoteDescription({ type: "offer", sdp })
      for (const track of stream.getTracks()) peer.addTrack(track, stream)
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      return { sdp: answer.sdp! }
    } catch (error) {
      await desktopPreview.close(sessionId)
      throw error
    }
  },
  async candidate(sessionId, candidate) {
    await peers.get(sessionId)?.peer.addIceCandidate({
      candidate: candidate.candidate,
      ...(candidate.sdpMid != null ? { sdpMid: candidate.sdpMid } : {}),
      ...(candidate.sdpMlineIndex != null ? { sdpMLineIndex: candidate.sdpMlineIndex } : {}),
      ...(candidate.usernameFragment != null ? { usernameFragment: candidate.usernameFragment } : {}),
    })
  },
  start: async () => {},
  async close(sessionId) {
    const preview = peers.get(sessionId)
    if (!preview) return
    clearInterval(preview.timer)
    preview.peer.onicecandidate = null
    preview.peer.close()
    preview.stream.getTracks().forEach(track => track.stop())
    peers.delete(sessionId)
  },
  onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
}
