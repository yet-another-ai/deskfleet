import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import type { DesktopCapabilities } from "@deskfleet/client/desktop-media"

export const desktopPreviewMachines: Machine[] = [
  { id: "machine-1", teamId: "team-1", name: "MacBook Pro (Studio)", originId: "origin-1", localMachineId: "local-1", online: true, capabilities: { desktop: true } },
  { id: "fixture-studio", teamId: "team-1", name: "Studio Mac", originId: "fixture", localMachineId: "2", online: true, capabilities: { desktop: true } },
  { id: "fixture-offline", teamId: "team-1", name: "Test laptop", originId: "fixture", localMachineId: "3", online: false, capabilities: { desktop: true } },
  { id: "fixture-headless", teamId: "team-1", name: "Linux runner", originId: "fixture", localMachineId: "4", online: true, capabilities: { desktop: false } },
]

/** Browser-local loopback streams contain generated fixture screens, never a real desktop. */
export function desktopPreviewCentral(base: CentralApi): { central: CentralApi; dispose(): void } {
  const listeners = new Set<(event: CentralEvent) => void>()
  const peers = new Map<string, { peer: RTCPeerConnection; stream: MediaStream; timer: ReturnType<typeof setInterval> }>()
  function close(id: string): void {
    const value = peers.get(id)
    if (!value) return
    clearInterval(value.timer)
    value.peer.close()
    value.stream.getTracks().forEach(track => track.stop())
    peers.delete(id)
  }
  const central: CentralApi = {
    ...base,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    machines: async () => desktopPreviewMachines,
    rpc: async <T>(_teamId: string, machineId: string) => ({ audio: false, displays: (machineId === "machine-1" ? [1, 2] : [1]).map(id => ({ id, width: 1920, height: 1080, refreshRateHz: 60, codecs: ["h264"] })) } satisfies DesktopCapabilities) as T,
    async createPeer(teamId, machineId) {
      const peerId = crypto.randomUUID()
      const peer = new RTCPeerConnection({ iceServers: [] })
      const canvas = document.createElement("canvas")
      canvas.width = 320; canvas.height = 180
      const context = canvas.getContext("2d")!
      const draw = () => {
        context.fillStyle = machineId === "machine-1" ? "#111827" : "#233b4b"
        context.fillRect(0, 0, 320, 180)
        context.fillStyle = "#334155"; context.fillRect(0, 0, 320, 20)
        context.fillStyle = "#cbd5e1"; context.font = "9px monospace"
        context.fillText("STORYBOOK FIXTURE · GENERATED SCREEN", 10, 13)
        context.fillStyle = "#94a3b8"; context.fillText("~/workspace/deskfleet", 14, 41)
        context.fillStyle = "#e2e8f0"; context.fillText("$ mise run check", 14, 61)
        context.fillStyle = "#4ade80"
        ;["✓ TypeScript checks passed", "✓ Renderer tests passed", "✓ Native capture ready"].forEach((line, index) => context.fillText(line, 14, 83 + index * 18))
        context.fillStyle = "#94a3b8"; context.fillText(new Date().toLocaleTimeString(), 14, 161)
      }
      draw()
      const stream = canvas.captureStream(1)
      stream.getTracks().forEach(track => peer.addTrack(track, stream))
      peers.set(peerId, { peer, stream, timer: setInterval(draw, 1000) })
      peer.onicecandidate = event => {
        if (!event.candidate) return
        const candidate = event.candidate.toJSON()
        const value = { kind: "iceCandidate" as const, candidate: { candidate: candidate.candidate!, sdpMid: candidate.sdpMid, sdpMlineIndex: candidate.sdpMLineIndex } }
        for (const listener of listeners) listener({ type: "peerEvent", peerId, event: value })
      }
      return { peerId, iceServers: [], authorization: {
        peerId, teamId, transport: "webrtc", serverId: "storybook", actor: { kind: "user", userId: "fixture", deviceId: "fixture" },
        targetMachine: { id: machineId, originId: "fixture", localMachineId: "fixture" }, purpose: "desktop", actions: [],
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      } }
    },
    async offerPeer(id, sdp) {
      const peer = peers.get(id)!.peer
      await peer.setRemoteDescription({ type: "offer", sdp })
      await peer.setLocalDescription(await peer.createAnswer())
      return { sdp: peer.localDescription!.sdp }
    },
    async candidatePeer(id, candidate) { await peers.get(id)?.peer.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMlineIndex }) },
    startPeer: async () => {},
    async closePeer(id) { close(id) },
  }
  return { central, dispose: () => { for (const id of peers.keys()) close(id) } }
}
