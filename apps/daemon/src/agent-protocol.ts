import type { ContentBlock, CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest, SessionNotification, Usage } from "@agentclientprotocol/sdk/unstable"
import type { GitDiffRequest, GitFileDiff, GitStatusSnapshot } from "./git-protocol.ts"
import type { ComposerReferenceResolve, ComposerReferenceResult, ComposerReferenceSearch } from "./composer-reference-protocol.ts"

import type { AgentConfiguration, AgentConfigurationParams, AgentConfigurationSelection, AgentPromptCapabilities } from "./agent-configuration-protocol.ts"

export const AGENT_CHANNEL = "deskfleet-acp"
export const AGENT_CHUNK_BYTES = 16 * 1024
export const AGENT_MESSAGE_BYTES = 32 * 1024 * 1024

export interface AgentActor {
  kind: "local_token" | "user" | "system"
  userId?: string
  sourceMachine?: { originId: string; id: string }
  deviceId?: string
}

export type AgentSessionContext = "worktree" | "directory"

export interface AgentSessionRecord {
  id: string
  /** Absent for machine-scoped Sessions started without a Workspace. */
  workspaceId?: string
  /** Stable ID of the configured provider on the executing machine. */
  provider: string
  providerSessionId?: string
  title: string
  /** A user rename takes precedence over later provider title updates. */
  titleCustomized?: boolean
  /** A generated worktree, or the Workspace's own directories used in place. */
  context: AgentSessionContext
  lifecycle: "provisioning" | "ready" | "provision_failed" | "deleting"
  /** Archiving blocks execution while resource closure is pending or failed. */
  archiveState: "active" | "archiving" | "archived"
  /** Immutable usage captured from the source Session at fork creation. */
  inheritedTurnCount?: number
  admissionGeneration?: string
  turnLimitReason?: string
  lastEventSeq: string
  createdAt: string
  updatedAt: string
  capabilities?: { steering: boolean; resume: boolean; fork?: boolean; promptCapabilities?: AgentPromptCapabilities }
  error?: string
}

export interface AgentRun {
  sessionId: string
  generation: number
  state: "starting" | "running" | "stopping" | "stopped" | "interrupted" | "failed"
  startedAt: string
  endedAt?: string
  error?: string
}

export interface AgentCommand {
  id: string
  operationId: string
  actor: AgentActor
  sessionId?: string
  workspaceId?: string
  method: string
  params: Record<string, unknown>
  isCanonical: boolean
  conflictingCommandId?: string
  status: "accepted" | "completed" | "rejected" | "failed" | "uncertain"
  result?: unknown
  error?: string
  receivedAt: string
  completedAt?: string
}

export interface AgentInput {
  id: string
  sessionId: string
  submissionCommandId: string
  author: AgentActor
  content: ContentBlock[]
  acceptedSeq: string
  state: "pending" | "dispatching" | "delivered" | "failed" | "withdrawn" | "uncertain"
  requestedDelivery: "backlog" | "steer"
  requestedTurnId?: string
  dispatchCommandId?: string
  dispatcher?: AgentActor
  actualDelivery?: "turn_start" | "steer"
  turnId?: string
  createdAt: string
  deliveredAt?: string
  error?: string
}

export interface AgentTurn {
  id: string
  sessionId: string
  initialInputId: string
  dispatchCommandId: string
  runGeneration: number
  state: "starting" | "running" | "cancelling" | "completed" | "cancelled" | "interrupted" | "failed"
  /** Persisted before calling the provider; false for confirmed unsent attempts. */
  consumed?: boolean
  startedAt: string
  endedAt?: string
  stopReason?: string
  /** Provider-reported token usage for this turn; absent when not reported. */
  usage?: Usage
  error?: string
}

export interface AgentPermission {
  id: string
  sessionId: string
  runGeneration: number
  turnId?: string
  request: RequestPermissionRequest
  state: "pending" | "resolved" | "cancelled"
  decisionCommandId?: string
  optionId?: string
  actor?: AgentActor
  createdAt: string
  resolvedAt?: string
}

export interface AgentSnapshot {
  session: AgentSessionRecord
  runs: AgentRun[]
  inputs: AgentInput[]
  turns: AgentTurn[]
  permissions: AgentPermission[]
  elicitations: AgentElicitation[]
}

/** A shared user question whose live provider callback belongs to the daemon. */
export interface AgentElicitation {
  id: string
  sessionId: string
  runGeneration: number
  turnId?: string
  request: CreateElicitationRequest
  state: "pending" | "resolved" | "cancelled"
  response?: CreateElicitationResponse
  decisionCommandId?: string
  actor?: AgentActor
  createdAt: string
  resolvedAt?: string
  /** URL interaction completion is independent of the user's consent. */
  completedAt?: string
}

export interface AgentEvent {
  sessionId: string
  seq: string
  kind: "session" | "run" | "input" | "turn" | "permission" | "elicitation" | "acp" | "command"
  payload: AgentSessionRecord | AgentRun | AgentInput | AgentTurn | AgentPermission | AgentElicitation | AgentCommand | SessionNotification
  createdAt: string
  turnId?: string
  inputId?: string
  commandId?: string
  runGeneration?: number
}

export type AgentEventDraft = Omit<AgentEvent, "seq">

/** One native transaction; omitted row collections remain unchanged. */
export interface AgentCommit {
  sessionId?: string
  expectedSeq?: string
  session?: AgentSessionRecord
  runs?: AgentRun[]
  inputs?: AgentInput[]
  turns?: AgentTurn[]
  permissions?: AgentPermission[]
  elicitations?: AgentElicitation[]
  command?: AgentCommand
  events?: AgentEventDraft[]
}

export interface AgentReceipt { operationId: string; commandId: string; inputId?: string; sessionId: string }
export interface AgentMutation { sessionId: string; operationId: string }
export interface AgentMethods {
  "_deskfleet/agent/configuration": { params: AgentConfigurationParams; result: AgentConfiguration | null }
  "_deskfleet/session/configuration": { params: { sessionId: string; composer?: boolean }; result: AgentConfiguration }
  "_deskfleet/composer/references": { params: ComposerReferenceSearch; result: ComposerReferenceResult }
  "_deskfleet/composer/resolve": { params: ComposerReferenceResolve; result: ContentBlock[] }
  "_deskfleet/session/configure": { params: AgentMutation & AgentConfigurationSelection; result: AgentConfiguration }
  "_deskfleet/session/list": { params: Record<string, never>; result: AgentSessionRecord[] }
  "_deskfleet/session/create": { params: { workspaceId?: string; operationId: string; title?: string; provider: string; context: AgentSessionContext } & AgentConfigurationSelection; result: AgentSnapshot }
  "_deskfleet/session/fork": { params: AgentMutation & { context: AgentSessionContext; title?: string }; result: AgentSnapshot }
  "_deskfleet/session/subscribe": { params: { sessionId: string }; result: AgentSnapshot }
  "_deskfleet/session/history": { params: { sessionId: string; afterSeq: string; limit?: number }; result: AgentEvent[] }
  "_deskfleet/git/status": { params: { sessionId: string; force?: boolean }; result: GitStatusSnapshot }
  "_deskfleet/git/diff": { params: GitDiffRequest; result: GitFileDiff }
  /** Viewer-owned, transient subscriptions; never written to the Session journal. */
  "_deskfleet/git/subscribe": { params: { sessionId: string; subscriptionId: string }; result: null }
  "_deskfleet/git/unsubscribe": { params: { subscriptionId: string }; result: null }
  "_deskfleet/input/submit": { params: AgentMutation & { content: ContentBlock[]; delivery: "backlog" | "steer"; turnId?: string }; result: AgentReceipt }
  "_deskfleet/input/steer": { params: AgentMutation & { inputId: string; turnId: string }; result: AgentReceipt }
  "_deskfleet/input/withdraw": { params: AgentMutation & { inputId: string }; result: AgentReceipt }
  "_deskfleet/input/retry": { params: AgentMutation & { inputId: string }; result: AgentReceipt }
  "_deskfleet/turn/cancel": { params: AgentMutation & { turnId: string }; result: AgentReceipt }
  "_deskfleet/permission/respond": { params: AgentMutation & { permissionId: string; optionId: string }; result: AgentPermission }
  "_deskfleet/elicitation/respond": { params: AgentMutation & { elicitationId: string; response: CreateElicitationResponse }; result: AgentElicitation }
  "_deskfleet/session/resume": { params: AgentMutation; result: AgentSnapshot }
  "_deskfleet/session/stop": { params: AgentMutation; result: AgentSnapshot }
  "_deskfleet/session/archive": { params: AgentMutation; result: AgentSnapshot }
  "_deskfleet/session/restore": { params: AgentMutation; result: AgentSnapshot }
  "_deskfleet/session/rename": { params: AgentMutation & { title: string }; result: AgentSnapshot }
  /** Internal maintenance only; not exposed by the client DataChannel facade. */
  "_deskfleet/session/delete": { params: AgentMutation; result: null }
  "_deskfleet/command/get": { params: { operationId: string }; result: AgentCommand | null }
}

export type AgentMethod = keyof AgentMethods
