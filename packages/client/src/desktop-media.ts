import type {
  DesktopCapabilities,
  DesktopErrorReason,
  DesktopEvent,
  DesktopOffer,
  DesktopStart,
  IceCandidate,
} from "@deskfleet/protocol/control"
export { desktopErrorReason, isDesktopErrorReason } from "@deskfleet/protocol/control"
import type { RelayDeniedReason } from "./relay.ts"
import type { NativeDesktopOptions } from "./native-desktop.ts"

export type {
  DesktopCapabilities,
  DesktopDisplay,
  DesktopErrorReason,
  DesktopEvent,
  DesktopOffer,
  DesktopStart,
  IceCandidate,
  VideoCodec,
} from "@deskfleet/protocol/control"

/** Starts after SDP/ICE setup and covers the server RPC plus first-frame delivery. */
export const DESKTOP_START_TIMEOUT_MS = 120_000

/** A local connection target; this is not an enrolled machine identity. */
export interface LocalDesktopTarget {
  id: string
  name: string
  online: boolean
  desktop: boolean
  /** The target daemon's OS, independent of the viewer's host platform. */
  platform?: string
  error?: string
}

export interface DesktopMediaApi {
  /** Opens a separate native window for this authorized machine. */
  openNative?(options: NativeDesktopOptions): Promise<void>
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  /** Additional context for a transport failure, without masking authorization errors. */
  connectionFailure?(sessionId: string): string | undefined
  /** The grant's structured reason, consulted only after a transport failure. */
  connectionFailureReason?(sessionId: string): RelayDeniedReason | null | undefined
  target(options?: { background?: boolean }): Promise<LocalDesktopTarget>
  capabilities(): Promise<DesktopCapabilities>
  offer(options: DesktopOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  start(options: DesktopStart): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}

export type DesktopMediaResult<T> = { ok: true; value: T } | { ok: false; error: string; reason?: DesktopErrorReason }

export const DESKTOP_MEDIA_CHANNEL = "deskfleet:desktop-media"
export const DESKTOP_MEDIA_EVENT = "deskfleet:desktop-event"
