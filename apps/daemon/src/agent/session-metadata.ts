import type { AgentCommand, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import { requiredString } from "./params.ts"
import { timestamp, type AgentJournal } from "./store.ts"

// Titles, read marks, and viewers describe a Session to people. Changing them
// never starts, stops, or reconfigures its Agent.

const nextSeq = (session: AgentSessionRecord) => String(BigInt(session.lastEventSeq) + 1n)

/** Completes the command with the Session's record, changed only when `change` returns one. */
function updateRecord(journal: AgentJournal, command: AgentCommand, closed: () => boolean, change: (snapshot: AgentSnapshot) => AgentSessionRecord | undefined): Promise<AgentSnapshot> {
  const sessionId = command.sessionId!
  return journal.serial(sessionId, async () => {
    const snapshot = await journal.read(sessionId)
    if (closed()) throw new Error("Agent service is stopping")
    if (snapshot.session.lifecycle === "deleting") throw new Error("Session deletion is in progress")
    const changed = change(snapshot)
    const result = { ...snapshot, session: changed ?? snapshot.session }
    await journal.commit(snapshot, {
      ...(changed ? { session: changed } : {}),
      command: { ...command, status: "completed", result, completedAt: timestamp() },
      ...(changed ? { events: [journal.event(sessionId, "session", changed, { commandId: command.id })] } : {}),
    })
    return result
  })
}

export function renameSession(journal: AgentJournal, command: AgentCommand, closed: () => boolean): Promise<AgentSnapshot> {
  const title = requiredString(command.params.title, "Session title").trim()
  if (!title || title.length > 200 || title.includes("\0")) throw new Error("Session titles must contain between 1 and 200 characters")
  return updateRecord(journal, command, closed, snapshot => ({
    ...snapshot.session, title, titleCustomized: true, updatedAt: timestamp(), lastEventSeq: nextSeq(snapshot.session),
  }))
}

export function markSessionRead(journal: AgentJournal, command: AgentCommand, closed: () => boolean): Promise<AgentSnapshot> {
  if (command.actor.kind !== "user" || !command.actor.userId) throw new Error("Only a person can mark a Session as read")
  const throughSeq = requiredString(command.params.throughSeq, "read watermark")
  if (!/^(0|[1-9][0-9]*)$/u.test(throughSeq)) throw new Error("Invalid read watermark")
  return updateRecord(journal, command, closed, snapshot => {
    if (BigInt(throughSeq) > BigInt(snapshot.session.lastEventSeq)) throw new Error("Read watermark exceeds Session history")
    if (BigInt(throughSeq) <= BigInt(snapshot.session.lastReadSeq ?? "0")) return undefined
    return { ...snapshot.session, lastReadSeq: throughSeq, lastEventSeq: nextSeq(snapshot.session) }
  })
}

export function markSessionUnread(journal: AgentJournal, command: AgentCommand, closed: () => boolean): Promise<AgentSnapshot> {
  if (command.actor.kind !== "user" || !command.actor.userId) throw new Error("Only a person can mark a Session as unread")
  return updateRecord(journal, command, closed, snapshot => {
    const completed = snapshot.session.lastCompletedSeq
    if (!completed || !/^(?:[1-9][0-9]*)$/u.test(completed)) throw new Error("This Session has no completed result to mark unread")
    if (BigInt(completed) > BigInt(snapshot.session.lastReadSeq ?? "0")) return undefined
    return { ...snapshot.session, lastReadSeq: String(BigInt(completed) - 1n), lastEventSeq: nextSeq(snapshot.session) }
  })
}

export function rememberSessionViewer(journal: AgentJournal, sessionId: string, userId: string, closed: () => boolean): Promise<void> {
  return journal.serial(sessionId, async () => {
    if (closed()) return
    const snapshot = await journal.read(sessionId)
    const seenAt = timestamp()
    const viewers = snapshot.session.viewers ?? []
    const session = {
      ...snapshot.session,
      viewers: viewers.some(viewer => viewer.userId === userId)
        ? viewers.map(viewer => viewer.userId === userId ? { userId, seenAt } : viewer)
        : [...viewers, { userId, seenAt }],
      updatedAt: seenAt,
      lastEventSeq: nextSeq(snapshot.session),
    }
    await journal.commit(snapshot, { session, events: [journal.event(sessionId, "session", session)] })
  })
}
