import * as acp from "@agentclientprotocol/sdk/unstable"

/** Cursor's blocking multiple-choice request. Its documented params omit a session id. */
export const CURSOR_ASK_QUESTION_METHOD = "cursor/ask_question"
/** Grok's blocking question request. */
export const GROK_ASK_USER_QUESTION_METHOD = "x.ai/ask_user_question"
/** Alias observed on Grok ACP clients alongside the dotted method name. */
export const GROK_ASK_USER_QUESTION_ALIAS = "_x.ai/ask_user_question"

export const VENDOR_QUESTION_METHODS = [
  CURSOR_ASK_QUESTION_METHOD,
  GROK_ASK_USER_QUESTION_METHOD,
  GROK_ASK_USER_QUESTION_ALIAS,
] as const

interface Option {
  value: string
  label: string
  description?: string
  preview?: string
}
interface ParsedQuestion {
  id: string
  title: string
  multiple: boolean
  options: Option[]
}
interface ParsedQuestions {
  request: acp.CreateElicitationRequest
  questions: ParsedQuestion[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

function flag(value: unknown): boolean | undefined {
  if (value == null) return false
  return typeof value === "boolean" ? value : undefined
}

function options(value: unknown, valueOf: (option: Record<string, unknown>) => string | undefined): Option[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parsed: Option[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const label = text(item.label)
    const optionValue = valueOf(item)
    if (!label || !optionValue) return undefined
    const description = [text(item.description), text(item.preview)].filter(part => part !== undefined).join("\n")
    const preview = text(item.preview)
    parsed.push({ value: optionValue, label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) })
  }
  if (new Set(parsed.map(option => option.value)).size !== parsed.length) return undefined
  return parsed
}

function property(question: ParsedQuestion): acp.ElicitationPropertySchema {
  const choices = question.options.map(option => ({
    const: option.value, title: option.label, ...(option.description ? { description: option.description } : {}),
  }))
  if (question.multiple) return { type: "array", title: question.title, minItems: 1, items: { anyOf: choices } }
  return { type: "string", title: question.title, oneOf: choices }
}

function form(sessionId: string, toolCallId: string, message: string, questions: ParsedQuestion[]): acp.CreateElicitationRequest {
  return {
    mode: "form", sessionId, toolCallId, message, requestedSchema: {
      type: "object",
      required: questions.map(question => question.id),
      properties: Object.fromEntries(questions.map(question => [question.id, property(question)])),
    },
  }
}

/** Cursor's published request has `toolCallId` and `questions`, not a session id. */
function parseCursor(params: unknown, sessionId: string | undefined): ParsedQuestions | undefined {
  if (!isRecord(params) || !Array.isArray(params.questions) || params.questions.length === 0) return undefined
  const scoped = text(params.sessionId) ?? sessionId
  const toolCallId = text(params.toolCallId)
  if (!scoped || !toolCallId) return undefined
  const questions: ParsedQuestion[] = []
  for (const item of params.questions) {
    if (!isRecord(item)) return undefined
    const id = text(item.id)
    const title = text(item.prompt)
    const multiple = flag(item.allowMultiple)
    const choices = options(item.options, option => text(option.id))
    if (!id || !title || multiple === undefined || !choices) return undefined
    questions.push({ id, title, multiple, options: choices })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length) return undefined
  return { questions, request: form(scoped, toolCallId, text(params.title) ?? questions[0]!.title, questions) }
}

function parseGrok(params: unknown): ParsedQuestions | undefined {
  if (!isRecord(params) || !Array.isArray(params.questions) || params.questions.length === 0) return undefined
  const sessionId = text(params.sessionId)
  const toolCallId = text(params.toolCallId)
  if (!sessionId || !toolCallId) return undefined
  const questions: ParsedQuestion[] = []
  for (const item of params.questions) {
    if (!isRecord(item)) return undefined
    const title = text(item.question)
    const camel = "multiSelect" in item ? item.multiSelect : undefined
    const snake = "multi_select" in item ? item.multi_select : undefined
    if (camel != null && snake != null && camel !== snake) return undefined
    const multiple = flag(camel ?? snake)
    const choices = options(item.options, option => text(option.label))
    if (!title || multiple === undefined || !choices) return undefined
    questions.push({ id: title, title, multiple, options: choices })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length) return undefined
  return { questions, request: form(sessionId, toolCallId, questions[0]!.title, questions) }
}

function selected(question: ParsedQuestion, value: unknown): string[] | undefined {
  const values = question.multiple
    ? (Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined)
    : (typeof value === "string" ? [value] : undefined)
  if (!values?.length || new Set(values).size !== values.length) return undefined
  const allowed = new Set(question.options.map(option => option.value))
  return values.every(item => allowed.has(item)) ? values : undefined
}

function cursorOutcome(questions: ParsedQuestion[], response: acp.CreateElicitationResponse) {
  if (response.action === "decline") return { outcome: { outcome: "skipped" as const } }
  if (!acp.CreateElicitationResponse.isAccept(response)) return { outcome: { outcome: "cancelled" as const } }
  const answers = []
  for (const question of questions) {
    const values = selected(question, response.content?.[question.id])
    if (!values) return { outcome: { outcome: "cancelled" as const } }
    answers.push({ questionId: question.id, selectedOptionIds: values })
  }
  return { outcome: { outcome: "answered" as const, answers } }
}

function grokOutcome(questions: ParsedQuestion[], response: acp.CreateElicitationResponse) {
  if (!acp.CreateElicitationResponse.isAccept(response)) return { outcome: "cancelled" as const }
  const answers: Record<string, string[]> = {}
  const annotations: Record<string, { preview: string }> = {}
  for (const question of questions) {
    const values = selected(question, response.content?.[question.id])
    if (!values) return { outcome: "cancelled" as const }
    answers[question.id] = values
    if (!question.multiple && values.length === 1) {
      const preview = question.options.find(option => option.value === values[0])?.preview
      if (preview) annotations[question.id] = { preview }
    }
  }
  return Object.keys(annotations).length
    ? { outcome: "accepted" as const, answers, annotations }
    : { outcome: "accepted" as const, answers }
}

/**
 * Translates a vendor question into a session form and the form result back
 * into that vendor's response. A request that cannot be shown is cancelled.
 * Grok decline and cancel both become `cancelled`. Plan-mode outcomes
 * `chat_about_this` and `skip_interview` are not separate actions.
 */
export async function answerVendorQuestion(
  method: string,
  params: unknown,
  sessionId: string | undefined,
  ask: (request: acp.CreateElicitationRequest, signal: AbortSignal) => Promise<acp.CreateElicitationResponse>,
  signal: AbortSignal,
): Promise<unknown> {
  const cursor = method === CURSOR_ASK_QUESTION_METHOD
  const parsed = cursor ? parseCursor(params, sessionId) : parseGrok(params)
  if (!parsed) return cursor ? { outcome: { outcome: "cancelled" } } : { outcome: "cancelled" }
  const response = await ask(parsed.request, signal)
  return cursor ? cursorOutcome(parsed.questions, response) : grokOutcome(parsed.questions, response)
}
