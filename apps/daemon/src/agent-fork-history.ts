import type { SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentElicitation, AgentEvent, AgentEventDraft, AgentInput, AgentPermission, AgentRun, AgentSnapshot } from "./agent-protocol.ts"
import type { AgentJournal } from "./agent-store.ts"

const conversationUpdates = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"])

/** Copy an idle source's transcript once, before starting the new Session's provider. */
export async function copyForkHistory(journal: AgentJournal, source: AgentSnapshot, childId: string): Promise<void> {
  if (source.session.id === childId) throw new Error("A fork must have its own Session")
  const inputs = new Map(source.inputs.map(input => [input.id, input]))
  const permissions = new Map(source.permissions.map(permission => [permission.id, permission]))
  const elicitations = new Map(source.elicitations.map(elicitation => [elicitation.id, elicitation]))
  const seen = new Set<string>()
  const end = BigInt(source.session.lastEventSeq)

  function copy(event: AgentEvent): AgentEventDraft | undefined {
    let payload: AgentEvent["payload"]
    if (event.kind === "input") {
      const recorded = event.payload as AgentInput
      const current = inputs.get(recorded.id) ?? recorded
      if (current.state !== "delivered" || !["dispatching", "delivered"].includes(recorded.state)) return
      if (seen.has(`input:${current.id}`)) return
      seen.add(`input:${current.id}`)
      const { turnId: _turn, requestedTurnId: _requestedTurn, dispatchCommandId: _dispatch, ...input } = current
      payload = { ...input, sessionId: childId }
    } else if (event.kind === "permission" || event.kind === "elicitation") {
      const recorded = event.payload as AgentPermission | AgentElicitation
      const current = (event.kind === "permission" ? permissions : elicitations).get(recorded.id) ?? recorded
      if (current.state === "pending" || seen.has(`${event.kind}:${current.id}`)) return
      if (event.kind === "elicitation") {
        const question = current as AgentElicitation
        if (question.state === "resolved" && question.request.mode === "url" && question.response?.action === "accept" && !question.completedAt) return
      }
      seen.add(`${event.kind}:${current.id}`)
      const { turnId: _turn, decisionCommandId: _decision, ...resolved } = current
      payload = { ...resolved, sessionId: childId }
    } else if (event.kind === "acp") {
      const notification = event.payload as SessionNotification
      if (!conversationUpdates.has(notification.update.sessionUpdate)) return
      payload = { ...notification, sessionId: childId }
    } else {
      return
    }
    // Domain IDs in event context are foreign keys; inherited history has no live domain rows.
    return { sessionId: childId, kind: event.kind, payload, createdAt: event.createdAt, runGeneration: event.runGeneration }
  }

  await journal.serial(childId, async () => {
    // Reserve generations so later provider runs cannot merge reused tool/message IDs into history.
    let runs: AgentRun[] | undefined = source.runs.map(run => ({
      ...run, sessionId: childId, state: "stopped", endedAt: run.endedAt ?? source.session.updatedAt,
    }))
    let cursor = "0"
    while (BigInt(cursor) < end) {
      const page = await journal.history(source.session.id, cursor, 200)
      if (!page.length) break
      const events = page.filter(event => BigInt(event.seq) <= end).flatMap(event => {
        const inherited = copy(event)
        return inherited ? [inherited] : []
      })
      if (events.length) {
        await journal.commit(await journal.read(childId), { runs, events })
        runs = undefined
      }
      cursor = page.at(-1)!.seq
    }
  })
}
