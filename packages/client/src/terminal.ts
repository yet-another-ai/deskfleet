import type { DesktopEvent, IceCandidate, TerminalOffer } from "../../../apps/daemon/src/control-protocol.ts"
import type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "../../../apps/daemon/src/terminal-protocol.ts"

export type { TerminalDial, TerminalSessionEvent, TerminalSummary } from "../../../apps/daemon/src/terminal-protocol.ts"

export const TERMINAL_SESSION_EVENT = "deskfleet:terminal-session"

/** Shell lifecycle and SDP/ICE cross IPC; terminal input/output stays on the DataChannel. */
export interface TerminalSignalingApi {
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  list(): Promise<TerminalSummary[]>
  dial(options: TerminalDial): Promise<TerminalSummary>
  hangup(terminalId: string): Promise<void>
  onSessionEvent(listener: (event: TerminalSessionEvent) => void): () => void
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
