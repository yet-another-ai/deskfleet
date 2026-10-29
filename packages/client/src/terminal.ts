import type { DesktopEvent, IceCandidate, TerminalOffer } from "../../../apps/daemon/src/control-protocol.ts"
import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "../../../apps/daemon/src/terminal-protocol.ts"
import type { DataChannel } from "./data-channel.ts"

export type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "../../../apps/daemon/src/terminal-protocol.ts"

export const TERMINAL_SESSION_EVENT = "deskfleet:terminal-session"

/** Shell lifecycle is separate from the local or remote channel carrying terminal I/O. */
export interface TerminalSignalingApi {
  connectChannel?(sessionId: string): DataChannel
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  /** Additional context for a transport failure, without masking authorization errors. */
  connectionFailure?(sessionId: string): string | undefined
  list(): Promise<TerminalSummary[]>
  dial(options: TerminalDial): Promise<TerminalSummary>
  hangup(terminalId: string): Promise<void>
  onSessionEvent(listener: (event: TerminalSessionEvent) => void): () => void
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
