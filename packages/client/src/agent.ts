import type { AgentEvent, AgentMethod, AgentMethods, AgentSessionRecord, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { DesktopEvent, IceCandidate, TerminalOffer } from "../../../apps/daemon/src/control-protocol.ts"
import type { DataChannel } from "./data-channel.ts"

/** Agent operations share ACP framing across local and remote message channels. */
export interface AgentSignalingApi {
  connectChannel?(sessionId: string): DataChannel
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  /** Additional context for a transport failure, without masking authorization errors. */
  connectionFailure?(sessionId: string): string | undefined
  control?<M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]): Promise<AgentMethods[M]["result"]> | undefined
  history?: {
    available(): boolean
    list(): Promise<AgentSessionRecord[]>
    snapshot(sessionId: string): Promise<AgentSnapshot>
    events(sessionId: string, after: string, limit: number): Promise<AgentEvent[]>
  }
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
