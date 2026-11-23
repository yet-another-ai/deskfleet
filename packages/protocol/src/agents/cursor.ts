import type { AcpCreateElicitationRequest } from "./core.ts"

/** Cursor's blocking plan-approval request. Its documented params omit a session id. */
export const CURSOR_CREATE_PLAN_METHOD = "cursor/create_plan"

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

export function parseCursorPlanTodos(value: unknown): CursorPlanTodo[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: CursorPlanTodo[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const id = text(item.id)
    const content = text(item.content)
    const status = text(item.status)
    if (!id || !content || !status || !TODO_STATUSES.has(status)) return undefined
    parsed.push({ id, content, status: status as CursorPlanTodo["status"] })
  }
  if (new Set(parsed.map(entry => entry.id)).size !== parsed.length) return undefined
  return parsed
}

export function parseCursorPlanPhases(value: unknown): CursorPlanApproval["phases"] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) return undefined
  const parsed: NonNullable<CursorPlanApproval["phases"]> = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const name = text(item.name)
    const entries = parseCursorPlanTodos(item.todos)
    if (!name || !entries) return undefined
    parsed.push({ name, todos: entries })
  }
  return parsed
}

/**
 * Reads the Cursor plan attached when `cursor/create_plan` was translated into a
 * session form. Other elicitations return undefined.
 */
export function cursorPlanApproval(request: AcpCreateElicitationRequest): CursorPlanApproval | undefined {
  const meta = isRecord(request._meta) ? request._meta : undefined
  const deskfleet = isRecord(meta?.deskfleet) ? meta.deskfleet : undefined
  const plan = deskfleet?.cursorPlan
  if (!isRecord(plan) || typeof plan.plan !== "string" || plan.plan.length === 0) return undefined
  const entries = parseCursorPlanTodos(plan.todos)
  if (!entries) return undefined
  const grouped = parseCursorPlanPhases(plan.phases)
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
