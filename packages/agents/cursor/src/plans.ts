import * as acp from "@agentclientprotocol/sdk/unstable"
import {
  CURSOR_CREATE_PLAN_METHOD, cursorPlanApproval, parseCursorPlanPhases, parseCursorPlanTodos,
  type CursorPlanApproval, type CursorPlanTodo,
} from "./protocol.ts"

export { CURSOR_CREATE_PLAN_METHOD, cursorPlanApproval, type CursorPlanApproval, type CursorPlanTodo }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

/** Cursor's published request has `toolCallId` and `plan`, not a session id. */
function parseCursorPlan(params: unknown, sessionId: string | undefined): { request: acp.CreateElicitationRequest; plan: CursorPlanApproval } | undefined {
  if (!isRecord(params)) return undefined
  const scoped = text(params.sessionId) ?? sessionId
  const toolCallId = text(params.toolCallId)
  const plan = text(params.plan)
  const entries = parseCursorPlanTodos(params.todos)
  if (!scoped || !toolCallId || !plan || !entries) return undefined
  const grouped = parseCursorPlanPhases(params.phases)
  if (params.phases !== undefined && grouped === undefined) return undefined
  const isProject = typeof params.isProject === "boolean" ? params.isProject : undefined
  const approval: CursorPlanApproval = {
    plan,
    todos: entries,
    ...(text(params.name) ? { name: text(params.name) } : {}),
    ...(text(params.overview) ? { overview: text(params.overview) } : {}),
    ...(isProject !== undefined ? { isProject } : {}),
    ...(grouped ? { phases: grouped } : {}),
  }
  const message = approval.overview ?? approval.name ?? plan
  return {
    plan: approval,
    request: {
      mode: "form",
      sessionId: scoped,
      toolCallId,
      message,
      requestedSchema: { type: "object", properties: {} },
      _meta: { deskfleet: { cursorPlan: approval } },
    },
  }
}

function planOutcome(response: acp.CreateElicitationResponse) {
  if (response.action === "decline") return { outcome: { outcome: "rejected" as const } }
  if (acp.CreateElicitationResponse.isAccept(response)) return { outcome: { outcome: "accepted" as const } }
  return { outcome: { outcome: "cancelled" as const } }
}

/**
 * Translates Cursor's `cursor/create_plan` into a session form and maps the form
 * result back to Cursor's nested outcome. Accept → accepted, decline → rejected,
 * cancel → cancelled. A request that cannot be shown is cancelled.
 */
export async function answerCursorCreatePlan(
  params: unknown,
  sessionId: string | undefined,
  ask: (request: acp.CreateElicitationRequest, signal: AbortSignal) => Promise<acp.CreateElicitationResponse>,
  signal: AbortSignal,
): Promise<unknown> {
  const parsed = parseCursorPlan(params, sessionId)
  if (!parsed) return { outcome: { outcome: "cancelled" } }
  const response = await ask(parsed.request, signal)
  return planOutcome(response)
}
