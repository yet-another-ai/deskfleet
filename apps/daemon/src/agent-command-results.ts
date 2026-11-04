import type { AgentCommand, AgentEvent, AgentEventDraft } from "./agent-protocol.ts"

/** A completed mutation names its Session; loading current state never repeats the mutation. */
export interface AgentSnapshotReference {
  kind: "session_snapshot"
  sessionId: string
}

const snapshotMethods = new Set([
  "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/rename",
  "_deskfleet/session/read", "_deskfleet/session/unread", "_deskfleet/session/switch-agent",
  "_deskfleet/session/resume", "_deskfleet/session/stop", "_deskfleet/session/archive", "_deskfleet/session/restore",
])

export function isSnapshotReference(value: unknown): value is AgentSnapshotReference {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "session_snapshot"
    && "sessionId" in value && typeof value.sessionId === "string"
}

/** Keep request identity and outcome without copying all previous inputs into every receipt. */
export function compactCommandResult(command: AgentCommand): AgentCommand {
  if (!snapshotMethods.has(command.method)) return command
  const result = command.result
  if (!result || typeof result !== "object" || !("session" in result)) return command
  const session = result.session
  if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string") return command
  return { ...command, result: { kind: "session_snapshot", sessionId: session.id } satisfies AgentSnapshotReference }
}

export function compactCommandEvent<T extends AgentEvent | AgentEventDraft>(event: T): T {
  if (event.kind !== "command") return event
  return { ...event, payload: compactCommandResult(event.payload as AgentCommand) }
}
