import type { AcpCreateElicitationRequest } from "./core.ts"

/** Grok's blocking question request. */
export const GROK_ASK_USER_QUESTION_METHOD = "x.ai/ask_user_question"
/** Alias observed on Grok ACP clients alongside the dotted method name. */
export const GROK_ASK_USER_QUESTION_ALIAS = "_x.ai/ask_user_question"
/** Session config metadata key advertised by Grok ACP. */
export const GROK_SESSION_CONFIG_META_KEY = "x.ai/sessionConfig"

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

export function grokPlanInterview(request: AcpCreateElicitationRequest): boolean {
  const deskfleet = request._meta?.deskfleet
  return isRecord(deskfleet) && deskfleet.grokPlanInterview === true
}

/** Explicit plan-interview actions carry no answers and cannot be used on ordinary forms. */
export function grokPlanOutcome(value: unknown): "chat_about_this" | "skip_interview" | undefined {
  if (!isRecord(value) || value.action !== "accept" || !isRecord(value._meta) || !isRecord(value._meta.deskfleet)) return undefined
  const outcome = value._meta.deskfleet.grokOutcome
  return outcome === "chat_about_this" || outcome === "skip_interview" ? outcome : undefined
}
