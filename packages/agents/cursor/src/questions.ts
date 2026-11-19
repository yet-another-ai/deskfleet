import * as acp from "@agentclientprotocol/sdk/unstable"
import {
  buildQuestionForm, isQuestionRecord, nonEmptyText, parseQuestionFlag, parseQuestionOptions,
  selectedQuestionValues, type VendorParsedQuestion, type VendorParsedQuestions,
} from "@deskfleet/agent-core"

/** Cursor's blocking multiple-choice request. Its documented params omit a session id. */
export const CURSOR_ASK_QUESTION_METHOD = "cursor/ask_question"

function parseCursorQuestions(params: unknown, sessionId: string | undefined): VendorParsedQuestions | undefined {
  if (!isQuestionRecord(params) || !Array.isArray(params.questions) || params.questions.length === 0) return undefined
  const scoped = nonEmptyText(params.sessionId) ?? sessionId
  const toolCallId = nonEmptyText(params.toolCallId)
  if (!scoped || !toolCallId) return undefined
  const questions: VendorParsedQuestion[] = []
  for (const item of params.questions) {
    if (!isQuestionRecord(item)) return undefined
    const id = nonEmptyText(item.id)
    const title = nonEmptyText(item.prompt)
    const multiple = parseQuestionFlag(item.allowMultiple)
    const choices = parseQuestionOptions(item.options, option => nonEmptyText(option.id))
    if (!id || !title || multiple === undefined || !choices) return undefined
    questions.push({ id, title, multiple, options: choices })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length) return undefined
  return { questions, request: buildQuestionForm(scoped, toolCallId, nonEmptyText(params.title) ?? questions[0]!.title, questions) }
}

function cursorOutcome(questions: VendorParsedQuestion[], response: acp.CreateElicitationResponse) {
  if (response.action === "decline") return { outcome: { outcome: "skipped" as const } }
  if (!acp.CreateElicitationResponse.isAccept(response)) return { outcome: { outcome: "cancelled" as const } }
  const answers = []
  for (const question of questions) {
    const values = selectedQuestionValues(question, response.content?.[question.id])
    if (!values) return { outcome: { outcome: "cancelled" as const } }
    answers.push({ questionId: question.id, selectedOptionIds: values })
  }
  return { outcome: { outcome: "answered" as const, answers } }
}

/** Translates Cursor's `cursor/ask_question` into a session form and maps the result back to Cursor's outcome. */
export async function answerCursorQuestion(
  params: unknown,
  sessionId: string | undefined,
  ask: (request: acp.CreateElicitationRequest, signal: AbortSignal) => Promise<acp.CreateElicitationResponse>,
  signal: AbortSignal,
): Promise<unknown> {
  const parsed = parseCursorQuestions(params, sessionId)
  if (!parsed) return { outcome: { outcome: "cancelled" } }
  const response = await ask(parsed.request, signal)
  return cursorOutcome(parsed.questions, response)
}
