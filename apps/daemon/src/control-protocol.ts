import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "./terminal-protocol.ts"
import type { CatalogEvent, CatalogMethods } from "./catalog-protocol.ts"
import type { FilesystemMethods } from "./filesystem-protocol.ts"

/** Provisional local IPC contract. Media and terminal bytes stay on WebRTC. */
export type VideoCodec = "h264" | "h265" | "av1"

export interface IceCandidate {
  candidate: string
  sdpMid?: string
  sdpMlineIndex?: number
  usernameFragment?: string
}

export interface DesktopDisplay {
  id: number
  width: number
  height: number
  refreshRateHz: number
}

export interface DesktopCapabilities {
  displays: DesktopDisplay[]
  codecs: VideoCodec[]
  audio: boolean
}

export interface DesktopOffer {
  /** Chosen by the client before subscribing to trickle ICE events. */
  sessionId: string
  sdp: string
  codec: VideoCodec
  audio: boolean
}

export interface TerminalOffer {
  sessionId: string
  sdp: string
}

export interface DesktopStart {
  sessionId: string
  displayId: number
  fps?: number
  bitrateBps?: number
}

export type DesktopEvent =
  | { sessionId: string; kind: "iceCandidate"; candidate: IceCandidate }
  | { sessionId: string; kind: "stateChanged"; state: string }
  | { sessionId: string; kind: "error"; error: string }

export interface ScreenCapturePermission {
  status: "requesting" | "granted" | "denied" | "not-required" | "error"
  error?: string
}

export interface LocalDaemonInfo {
  name: string
  desktop: boolean
  screenCapturePermission: ScreenCapturePermission
}

export type DaemonEvent = DesktopEvent | TerminalSessionEvent | CatalogEvent
  | { kind: "screenCapturePermissionChanged"; permission: ScreenCapturePermission }

export interface ControlMethods extends CatalogMethods, FilesystemMethods {
  hello: { params: { token: string }; result: LocalDaemonInfo }
  shutdown: { params: Record<string, never>; result: null }
  capabilities: { params: Record<string, never>; result: DesktopCapabilities }
  offer: { params: DesktopOffer; result: { sdp: string } }
  terminalOffer: { params: TerminalOffer; result: { sdp: string } }
  agentOffer: { params: TerminalOffer; result: { sdp: string } }
  terminalList: { params: Record<string, never>; result: TerminalSummary[] }
  terminalDial: { params: TerminalDial; result: TerminalSummary }
  terminalHangup: { params: { terminalId: string }; result: null }
  candidate: { params: { sessionId: string; candidate: IceCandidate }; result: null }
  start: { params: DesktopStart; result: null }
  close: { params: { sessionId: string }; result: null }
}

export type ControlMethod = keyof ControlMethods
export type ControlRequest = {
  [M in ControlMethod]: { id: number; method: M; params: ControlMethods[M]["params"] }
}[ControlMethod]
export type ControlMessage =
  | { id: number; result: unknown; error?: never }
  | { id: number; error: string; result?: never }
  | { event: DaemonEvent }

export interface DaemonDiscovery {
  endpoint: string
  token: string
}

/** Limit client requests; accumulated catalog responses may be larger. */
export const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024
