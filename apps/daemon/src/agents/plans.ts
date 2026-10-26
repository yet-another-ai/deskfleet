import * as acp from "@agentclientprotocol/sdk"

/** Cursor's blocking plan-approval request. Its documented params omit a session id. */
export const CURSOR_CREATE_PLAN_METHOD = "cursor/create_plan"

export const VENDOR_PLAN_METHODS = [CURSOR_CREATE_PLAN_METHOD] as const

const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])

export interface CursorPlanTodo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

/** Plan payload shown in the shared elicitation UI and mapped back to Cursor's outcome. */
export interface CursorPlanApproval {
  name?: string
  overview?: string
  plan: string
  todos: CursorPlanTodo[]
  isProject?: boolean
  phases?: Array<{ name: string; todos: CursorPlanTodo[] }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

function todo(value: unknown): CursorPlanTodo | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id)
  const content = text(value.content)
  const status = text(value.status)
  if (!id || !content || !status || !TODO_STATUSES.has(status)) return undefined
  return { id, content, status: status as CursorPlanTodo["status"] }
}

function todos(value: unknown): CursorPlanTodo[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: CursorPlanTodo[] = []
  for (const item of value) {
    const entry = todo(item)
    if (!entry) return undefined
    parsed.push(entry)
  }
  if (new Set(parsed.map(entry => entry.id)).size !== parsed.length) return undefined
  return parsed
}

function phases(value: unknown): CursorPlanApproval["phases"] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) return undefined
  const parsed: NonNullable<CursorPlanApproval["phases"]> = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const name = text(item.name)
    const entries = todos(item.todos)
    if (!name || !entries) return undefined
    parsed.push({ name, todos: entries })
  }
  return parsed
}

/**
 * Reads the Cursor plan attached when `cursor/create_plan` was translated into a
 * session form. Other elicitations return undefined.
 */
export function cursorPlanApproval(request: acp.CreateElicitationRequest): CursorPlanApproval | undefined {
  const meta = isRecord(request._meta) ? request._meta : undefined
  const deskfleet = isRecord(meta?.deskfleet) ? meta.deskfleet : undefined
  const plan = deskfleet?.cursorPlan
  if (!isRecord(plan) || typeof plan.plan !== "string" || plan.plan.length === 0) return undefined
  const entries = todos(plan.todos)
  if (!entries) return undefined
  const grouped = phases(plan.phases)
  if (plan.phases !== undefined && grouped === undefined) return undefined
  return {
    plan: plan.plan,
    todos: entries,
    ...(text(plan.name) ? { name: text(plan.name) } : {}),
    ...(text(plan.overview) ? { overview: text(plan.overview) } : {}),
    ...(typeof plan.isProject === "boolean" ? { isProject: plan.isProject } : {}),
    ...(grouped ? { phases: grouped } : {}),
  }
}

/** Cursor's published request has `toolCallId` and `plan`, not a session id. */
function parseCursorPlan(params: unknown, sessionId: string | undefined): { request: acp.CreateElicitationRequest; plan: CursorPlanApproval } | undefined {
  if (!isRecord(params)) return undefined
  const scoped = text(params.sessionId) ?? sessionId
  const toolCallId = text(params.toolCallId)
  const plan = text(params.plan)
  const entries = todos(params.todos)
  if (!scoped || !toolCallId || !plan || !entries) return undefined
  const grouped = phases(params.phases)
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
