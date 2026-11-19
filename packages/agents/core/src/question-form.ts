import type * as acp from "@agentclientprotocol/sdk/unstable"

export interface VendorQuestionOption {
  value: string
  label: string
  description?: string
  preview?: string
}

export interface VendorParsedQuestion {
  id: string
  title: string
  multiple: boolean
  options: VendorQuestionOption[]
}

export interface VendorParsedQuestions {
  request: acp.CreateElicitationRequest
  questions: VendorParsedQuestion[]
}

export const isQuestionRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
export const nonEmptyText = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

export function parseQuestionFlag(value: unknown): boolean | undefined {
  if (value == null) return false
  return typeof value === "boolean" ? value : undefined
}

export function parseQuestionOptions(
  value: unknown,
  valueOf: (option: Record<string, unknown>) => string | undefined,
): VendorQuestionOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parsed: VendorQuestionOption[] = []
  for (const item of value) {
    if (!isQuestionRecord(item)) return undefined
    const label = nonEmptyText(item.label)
    const optionValue = valueOf(item)
    if (!label || !optionValue) return undefined
    const description = [nonEmptyText(item.description), nonEmptyText(item.preview)].filter(part => part !== undefined).join("\n")
    const preview = nonEmptyText(item.preview)
    parsed.push({ value: optionValue, label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) })
  }
  if (new Set(parsed.map(option => option.value)).size !== parsed.length) return undefined
  return parsed
}

function questionProperty(question: VendorParsedQuestion): acp.ElicitationPropertySchema {
  const choices = question.options.map(option => ({
    const: option.value, title: option.label, ...(option.description ? { description: option.description } : {}),
  }))
  if (question.multiple) return { type: "array", title: question.title, minItems: 1, items: { anyOf: choices } }
  return { type: "string", title: question.title, oneOf: choices }
}

export function buildQuestionForm(
  sessionId: string,
  toolCallId: string,
  message: string,
  questions: VendorParsedQuestion[],
): acp.CreateElicitationRequest {
  return {
    mode: "form", sessionId, toolCallId, message, requestedSchema: {
      type: "object",
      required: questions.map(question => question.id),
      properties: Object.fromEntries(questions.map(question => [question.id, questionProperty(question)])),
    },
  }
}

export function selectedQuestionValues(question: VendorParsedQuestion, value: unknown): string[] | undefined {
  const values = question.multiple
    ? (Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined)
    : (typeof value === "string" ? [value] : undefined)
  if (!values?.length || new Set(values).size !== values.length) return undefined
  const allowed = new Set(question.options.map(option => option.value))
  return values.every(item => allowed.has(item)) ? values : undefined
}
