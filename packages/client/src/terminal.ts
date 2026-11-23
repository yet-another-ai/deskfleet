import type { DesktopEvent, IceCandidate, TerminalOffer } from "@deskfleet/protocol/control"
import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "@deskfleet/protocol/terminal"
import type { DataChannel } from "./data-channel.ts"
import type { RelayDeniedReason } from "./relay.ts"

export type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "@deskfleet/protocol/terminal"

export const TERMINAL_SESSION_EVENT = "deskfleet:terminal-session"

/** Shell lifecycle is separate from the local or remote channel carrying terminal I/O. */
export interface TerminalSignalingApi {
  /** Each terminal can own an independent logical stream on a shared physical peer. */
  multiplexed?: boolean
  connectChannel?(sessionId: string): DataChannel
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  /** Additional context for a transport failure, without masking authorization errors. */
  connectionFailure?(sessionId: string): string | undefined
  connectionFailureReason?(sessionId: string): RelayDeniedReason | null | undefined
  list(): Promise<TerminalSummary[]>
  dial(options: TerminalDial): Promise<TerminalSummary>
  hangup(terminalId: string): Promise<void>
  onSessionEvent(listener: (event: TerminalSessionEvent) => void): () => void
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
