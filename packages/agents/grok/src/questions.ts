import * as acp from "@agentclientprotocol/sdk/unstable"
import {
  buildQuestionForm, isQuestionRecord, nonEmptyText, parseQuestionFlag, parseQuestionOptions,
  selectedQuestionValues, type VendorParsedQuestion, type VendorParsedQuestions,
} from "@deskfleet/agent-core"
import {
  GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD, grokPlanInterview, grokPlanOutcome,
} from "./protocol.ts"

export { GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD, grokPlanInterview, grokPlanOutcome }

function parseGrokQuestions(params: unknown): VendorParsedQuestions | undefined {
  if (!isQuestionRecord(params) || !Array.isArray(params.questions) || params.questions.length === 0) return undefined
  const sessionId = nonEmptyText(params.sessionId)
  const toolCallId = nonEmptyText(params.toolCallId)
  if (!sessionId || !toolCallId) return undefined
  const questions: VendorParsedQuestion[] = []
  for (const item of params.questions) {
    if (!isQuestionRecord(item)) return undefined
    const title = nonEmptyText(item.question)
    const camel = "multiSelect" in item ? item.multiSelect : undefined
    const snake = "multi_select" in item ? item.multi_select : undefined
    if (camel != null && snake != null && camel !== snake) return undefined
    const multiple = parseQuestionFlag(camel ?? snake)
    const choices = parseQuestionOptions(item.options, option => nonEmptyText(option.label))
    if (!title || multiple === undefined || !choices) return undefined
    questions.push({ id: title, title, multiple, options: choices })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length) return undefined
  const request = buildQuestionForm(sessionId, toolCallId, questions[0]!.title, questions)
  if (params.mode === "plan") request._meta = { deskfleet: { grokPlanInterview: true } }
  return { questions, request }
}

function grokOutcome(questions: VendorParsedQuestion[], response: acp.CreateElicitationResponse) {
  if (!acp.CreateElicitationResponse.isAccept(response)) return { outcome: "cancelled" as const }
  const answers: Record<string, string[]> = {}
  const annotations: Record<string, { preview: string }> = {}
  for (const question of questions) {
    const values = selectedQuestionValues(question, response.content?.[question.id])
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
 * Translates Grok's `x.ai/ask_user_question` (and `_x.ai/ask_user_question`) into a
 * session form and maps the result back. Decline and cancel both become `cancelled`;
 * plan interviews expose explicit discussion and skip actions through form metadata.
 */
export async function answerGrokQuestion(
  params: unknown,
  ask: (request: acp.CreateElicitationRequest, signal: AbortSignal) => Promise<acp.CreateElicitationResponse>,
  signal: AbortSignal,
): Promise<unknown> {
  const parsed = parseGrokQuestions(params)
  if (!parsed) return { outcome: "cancelled" }
  const response = await ask(parsed.request, signal)
  const planOutcome = grokPlanInterview(parsed.request) ? grokPlanOutcome(response) : undefined
  if (planOutcome) return { outcome: planOutcome }
  return grokOutcome(parsed.questions, response)
}
