import { vi } from "vitest"
import type { DesktopEvent, DesktopMediaApi } from "../../../client/src/desktop-media.ts"

export const browserCodecs: RTCRtpCodec[] = [
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=64001f;packetization-mode=1" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=0" },
  { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: "profile-id=1" },
  { mimeType: "video/AV1", clockRate: 90000, sdpFmtpLine: "profile=0" },
]

export class TestPeer {
  static instances: TestPeer[] = []
  connectionState: RTCPeerConnectionState = "new"
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null
  codecPreferences = vi.fn()
  addTransceiver = vi.fn((_kind: string, _init: RTCRtpTransceiverInit) => ({ setCodecPreferences: this.codecPreferences }))
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: "offer", sdp: "browser-offer" }))
  setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {})
  setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {})
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {})
  close = vi.fn(() => { this.connectionState = "closed" })

  constructor() { TestPeer.instances.push(this) }
  changeState(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
  emitCandidate(candidate: RTCIceCandidateInit): void {
    this.onicecandidate?.({ candidate: { toJSON: () => candidate } })
  }
}

class TestMediaStream {
  tracks: MediaStreamTrack[] = []
  addTrack(track: MediaStreamTrack): void { this.tracks.push(track) }
  getTracks(): MediaStreamTrack[] { return this.tracks }
}

export function stubWebRtc(): void {
  TestPeer.instances = []
  vi.stubGlobal("RTCPeerConnection", TestPeer)
  vi.stubGlobal("MediaStream", TestMediaStream)
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: vi.fn(() => ({ codecs: browserCodecs })) })
}

export function mockDesktopApi() {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const api = {
    target: vi.fn<DesktopMediaApi["target"]>(async () => ({ id: "local-daemon", name: "test-host", online: true, desktop: true })),
    capabilities: vi.fn<DesktopMediaApi["capabilities"]>(async () => ({
      displays: [
        { id: 1, width: 1920, height: 1080, refreshRateHz: 60 },
        { id: 2, width: 2560, height: 1440, refreshRateHz: 60 },
      ],
      codecs: ["av1", "h265", "h264"], audio: true,
    })),
    offer: vi.fn<DesktopMediaApi["offer"]>(async () => ({ sdp: "native-answer" })),
    candidate: vi.fn<DesktopMediaApi["candidate"]>(async () => {}),
    start: vi.fn<DesktopMediaApi["start"]>(async () => {}),
    close: vi.fn<DesktopMediaApi["close"]>(async () => {}),
    onEvent: vi.fn<DesktopMediaApi["onEvent"]>((listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  return { api, listeners, emit: (event: DesktopEvent) => { for (const listener of listeners) listener(event) } }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
