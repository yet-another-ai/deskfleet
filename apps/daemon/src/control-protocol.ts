import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "./terminal-protocol.ts"
import type { CatalogEvent, CatalogMethods } from "./catalog-protocol.ts"
import type { FilesystemMethods } from "./filesystem-protocol.ts"
import type { ProviderEvent, ProviderMethods } from "./provider-protocol.ts"
import type { CentralStatus, MachineEnrollment } from "./central-protocol.ts"

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
  codecs: VideoCodec[]
}

export interface DesktopCapabilities {
  displays: DesktopDisplay[]
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
  control?: boolean
  fps?: number
  bitrateBps?: number
}

/** Omitted by older daemons. Only `"encoder"` may open another peer. */
export type DesktopErrorReason = "encoder"

export type DesktopEvent =
  | { sessionId: string; kind: "iceCandidate"; candidate: IceCandidate }
  | { sessionId: string; kind: "stateChanged"; state: string }
  | { sessionId: string; kind: "error"; error: string; reason?: DesktopErrorReason }

export function desktopErrorEvent(sessionId: string, error: string, reason?: string | null): Extract<DesktopEvent, { kind: "error" }> {
  return { sessionId, kind: "error", error, ...(reason === "encoder" ? { reason: "encoder" } : {}) }
}

export function encoderFailure(message: string): Error & { reason: DesktopErrorReason } {
  return Object.assign(new Error(message), { reason: "encoder" as const })
}

export function isEncoderFailure(error: unknown): error is Error & { reason: DesktopErrorReason } {
  return typeof error === "object" && error !== null && (error as { reason?: unknown }).reason === "encoder"
}

function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(failureMessage).join("; ")}`
  return error instanceof Error ? error.message : String(error)
}

export function desktopStartupCleanupFailure(startupError: unknown, cleanup: unknown): AggregateError {
  const failure = new AggregateError([startupError, cleanup], `Desktop startup failed: ${failureMessage(startupError)}; peer cleanup failed: ${failureMessage(cleanup)}`, { cause: startupError })
  // Cleanup can report a terminated encoder after joining it. Retry policy still
  // belongs to the startup failure, never to a secondary cleanup diagnostic.
  return Object.assign(failure, isEncoderFailure(startupError) ? { reason: "encoder" as const } : {})
}

export interface DesktopPermission {
  status: "requesting" | "granted" | "denied" | "not-required" | "error"
  error?: string
}

export interface DesktopPermissionsState {
  screenCapturePermission: DesktopPermission
  accessibilityPermission: DesktopPermission
  fullDiskAccessPermission: DesktopPermission
}

export const DESKTOP_PERMISSION_KINDS = ["fullDiskAccess", "screenCapture", "accessibility"] as const
export type DesktopPermissionKind = typeof DESKTOP_PERMISSION_KINDS[number]

export interface LocalDaemonInfo extends DesktopPermissionsState {
  name: string
  desktop: boolean
}

export type DaemonEvent = DesktopEvent | TerminalSessionEvent | CatalogEvent | ProviderEvent
  | { kind: "desktopPermissionsChanged"; permissions: DesktopPermissionsState }

export interface ControlMethods extends CatalogMethods, FilesystemMethods, ProviderMethods {
  permissionsRefresh: { params: Record<string, never>; result: DesktopPermissionsState }
  permissionRequest: { params: { permission: DesktopPermissionKind }; result: DesktopPermissionsState }
  centralStatus: { params: Record<string, never>; result: CentralStatus }
  centralPrepareEnrollment: { params: Record<string, never>; result: CentralStatus }
  centralEnroll: { params: MachineEnrollment; result: CentralStatus }
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
  | { id: number; error: string; reason?: DesktopErrorReason; result?: never }
  | { event: DaemonEvent }

export interface DaemonDiscovery {
  endpoint: string
  token: string
}

/** Limit client requests; accumulated catalog responses may be larger. */
export const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024
