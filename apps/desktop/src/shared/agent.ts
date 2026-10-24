import type { DesktopEvent, IceCandidate, TerminalOffer } from "../../../daemon/src/control-protocol.ts"

/** IPC only negotiates the peer; agent operations and history use its ACP DataChannel. */
export interface AgentSignalingApi {
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
