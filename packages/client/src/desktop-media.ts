import type {
  DesktopCapabilities,
  DesktopEvent,
  DesktopOffer,
  DesktopStart,
  IceCandidate,
} from "../../../apps/daemon/src/control-protocol.ts"

export type {
  DesktopCapabilities,
  DesktopDisplay,
  DesktopEvent,
  DesktopOffer,
  DesktopStart,
  IceCandidate,
  VideoCodec,
} from "../../../apps/daemon/src/control-protocol.ts"

/** A local connection target; this is not an enrolled machine identity. */
export interface LocalDesktopTarget {
  id: string
  name: string
  online: boolean
  desktop: boolean
  error?: string
}

export interface DesktopMediaApi {
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  target(): Promise<LocalDesktopTarget>
  capabilities(): Promise<DesktopCapabilities>
  offer(options: DesktopOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  start(options: DesktopStart): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}

export type DesktopMediaResult<T> = { ok: true; value: T } | { ok: false; error: string; reason?: "encoder" }

export const DESKTOP_MEDIA_CHANNEL = "deskfleet:desktop-media"
export const DESKTOP_MEDIA_EVENT = "deskfleet:desktop-event"
