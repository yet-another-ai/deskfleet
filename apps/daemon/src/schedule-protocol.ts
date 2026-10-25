import { validateAgentConfigurationSelection, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import { resourceId } from "./catalog-protocol.ts"
import { validateProviderId } from "./provider-protocol.ts"

export type ScheduleTrigger =
  | { kind: "manual" }
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[] }

export type ScheduleTarget =
  | { kind: "new"; provider: string; context: "worktree" | "directory"; configuration?: AgentConfigurationSelection }
  | { kind: "existing"; sessionId: string }

export interface ScheduleInput {
  title: string
  prompt: string
  workspaceId: string
  enabled: boolean
  target: ScheduleTarget
  trigger: ScheduleTrigger
}

export interface ScheduleRun {
  id: string
  state: "claimed" | "running" | "completed" | "failed" | "interrupted" | "skipped"
  scheduledFor: string
  startedAt: string
  finishedAt?: string
  sessionId?: string
  inputId?: string
  error?: string
}

export interface ScheduledTask extends ScheduleInput {
  id: string
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  runs: ScheduleRun[]
  lastRun?: ScheduleRun
}

export interface ScheduleMethods {
  scheduleList: { params: Record<string, never>; result: ScheduledTask[] }
  scheduleCreate: { params: { schedule: ScheduleInput }; result: ScheduledTask }
  scheduleUpdate: { params: { scheduleId: string; changes: Partial<ScheduleInput> }; result: ScheduledTask }
  scheduleDelete: { params: { scheduleId: string }; result: null }
  scheduleRun: { params: { scheduleId: string }; result: ScheduleRun }
}
export type ScheduleMethod = keyof ScheduleMethods
export const SCHEDULE_METHODS = new Set<string>(["scheduleList", "scheduleCreate", "scheduleUpdate", "scheduleDelete", "scheduleRun"])

export function scheduleObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected schedule parameters")
  return value as Record<string, unknown>
}

function nonempty(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new Error(`Invalid schedule ${name}`)
  return value.trim()
}

export function scheduleTrigger(value: unknown): ScheduleTrigger {
  const trigger = scheduleObject(value)
  if (trigger.kind === "manual") return { kind: "manual" }
  if (trigger.kind === "interval") {
    if (!Number.isSafeInteger(trigger.minutes) || Number(trigger.minutes) < 1 || Number(trigger.minutes) > 525_600) throw new Error("Schedule interval must be between 1 and 525600 minutes")
    return { kind: "interval", minutes: trigger.minutes as number }
  }
  if (trigger.kind !== "daily" && trigger.kind !== "weekly") throw new Error("Invalid schedule trigger")
  const time = scheduleTime(trigger.time)
  const timeZone = nonempty(trigger.timeZone, "time zone", 100)
  try { new Intl.DateTimeFormat("en", { timeZone }).format() }
  catch { throw new Error("Invalid schedule time zone") }
  if (trigger.kind === "daily") return { kind: "daily", time, timeZone }
  if (!Array.isArray(trigger.weekdays) || !trigger.weekdays.length || trigger.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Choose at least one weekday between 0 (Sunday) and 6")
  return { kind: "weekly", time, timeZone, weekdays: [...new Set(trigger.weekdays as number[])].sort() }
}

/** Browser time controls may report seconds. Schedules persist minute precision. */
function scheduleTime(value: unknown): string {
  if (typeof value !== "string") throw new Error("Schedule time must use HH:mm")
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/u.exec(value)
  const hour = match?.[1]
  const minute = match?.[2]
  if (!hour || !minute) throw new Error("Schedule time must use HH:mm")
  return `${hour}:${minute}`
}

export function scheduleInput(value: unknown): ScheduleInput {
  const input = scheduleObject(value)
  resourceId(input.workspaceId)
  if (typeof input.enabled !== "boolean") throw new Error("Invalid schedule enabled state")
  const target = scheduleObject(input.target)
  let parsed: ScheduleTarget
  if (target.kind === "existing") {
    resourceId(target.sessionId)
    parsed = { kind: "existing", sessionId: target.sessionId as string }
  } else if (target.kind === "new") {
    validateProviderId(target.provider)
    if (target.context !== "worktree" && target.context !== "directory") throw new Error("Invalid scheduled Session context")
    parsed = { kind: "new", provider: target.provider as string, context: target.context }
    if (target.configuration !== undefined) {
      const config = scheduleObject(target.configuration)
      validateAgentConfigurationSelection(config)
      parsed.configuration = Object.fromEntries(["model", "reasoningEffort", "mode"].filter(key => config[key] !== undefined).map(key => [key, config[key]]))
    }
  } else throw new Error("Invalid schedule target")
  return { title: nonempty(input.title, "title", 200), prompt: nonempty(input.prompt, "prompt", 100_000), workspaceId: input.workspaceId as string,
    enabled: input.enabled, target: parsed, trigger: scheduleTrigger(input.trigger) }
}
