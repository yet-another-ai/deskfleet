import type { AgentActor, AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentSnapshot } from "../../../../../daemon/src/agent-protocol.ts"
export const actor: AgentActor = { kind: "user", userId: "Ada", sourceMachine: { originId: "origin", id: "10" } }
export function agentSnapshot(): AgentSnapshot {
  return { session: { id: "30", workspaceId: "20", provider: "codex", title: "Fix tests", context: "worktree", lifecycle: "ready", lastEventSeq: "0", createdAt: "now", updatedAt: "now", capabilities: { steering: true, resume: true } }, runs: [], inputs: [], turns: [], permissions: [], elicitations: [] }
}
export function agentInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return { id: "40", sessionId: "30", submissionCommandId: "50", author: actor, content: [{ type: "text", text: "Fix the tests" }], acceptedSeq: "1", state: "pending", requestedDelivery: "backlog", createdAt: "now", ...overrides }
}
export function agentPermission(overrides: Partial<AgentPermission> = {}): AgentPermission {
  return { id: "60", sessionId: "30", runGeneration: 1, state: "pending", createdAt: "now", request: { sessionId: "provider-session", toolCall: { toolCallId: "tool-1", title: "Run checks" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }, { optionId: "deny", kind: "reject_once", name: "Reject" }] }, ...overrides }
}
export function agentElicitation(overrides: Partial<AgentElicitation> = {}): AgentElicitation {
  return { id: "80", sessionId: "30", runGeneration: 1, turnId: "70", state: "pending", createdAt: "now", request: { sessionId: "provider-session", toolCallId: "question-1", mode: "form", message: "Choose the deployment target.", requestedSchema: { type: "object", properties: { target: { type: "string", title: "Deployment target", oneOf: [{ const: "staging", title: "Staging", description: "Try the changes first." }, { const: "production", title: "Production" }] } }, required: ["target"] } }, ...overrides }
}
export function agentEvent(seq: number, kind: AgentEvent["kind"], payload: AgentEvent["payload"]): AgentEvent {
  return { sessionId: "30", seq: String(seq), kind, payload, createdAt: "now", runGeneration: 1, turnId: "70" }
}
