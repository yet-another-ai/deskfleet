import type { AgentEvent, AgentMethod, AgentMethods, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { DesktopEvent, IceCandidate, TerminalOffer } from "@deskfleet/protocol/control"
import type { DataChannel } from "./data-channel.ts"
import type { RelayDeniedReason } from "./relay.ts"

/** Agent operations share ACP framing across local and remote message channels. */
export interface AgentSignalingApi {
  connectChannel?(sessionId: string): DataChannel
  prepare?(sessionId: string): Promise<RTCIceServer[]>
  /** Additional context for a transport failure, without masking authorization errors. */
  connectionFailure?(sessionId: string): string | undefined
  connectionFailureReason?(sessionId: string): RelayDeniedReason | null | undefined
  control?<M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]): Promise<AgentMethods[M]["result"]> | undefined
  history?: {
    /** Race retained history against remote attachment; disabled for local channels. */
    parallel?(): boolean
    available(): boolean
    list(options?: { background?: boolean }): Promise<(AgentSessionRecord & { working?: boolean | "working" | "permission" | "question" })[]>
    snapshot(sessionId: string): Promise<AgentSnapshot>
    events(sessionId: string, after: string, limit: number): Promise<AgentEvent[]>
  }
  offer(options: TerminalOffer): Promise<{ sdp: string }>
  candidate(sessionId: string, candidate: IceCandidate): Promise<void>
  close(sessionId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
