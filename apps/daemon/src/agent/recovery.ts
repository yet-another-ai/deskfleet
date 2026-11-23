import { liveTurn, timestamp, type AgentJournal } from "./store.ts"

/**
 * No provider process survives a daemon restart. Close the work it left open:
 * runs and turns become interrupted, questions are cancelled, and an input is
 * failed only when the journal proves its provider never received it.
 */
export async function recoverInterruptedSessions(journal: AgentJournal): Promise<void> {
  for (const session of await journal.list()) {
    await journal.serial(session.id, async () => {
      const snapshot = await journal.read(session.id)
      const runs = snapshot.runs.filter(run => ["starting", "running", "stopping"].includes(run.state))
        .map(run => ({ ...run, state: "interrupted" as const, endedAt: timestamp() }))
      const turns = snapshot.turns.filter(liveTurn)
        .map(turn => ({ ...turn, state: "interrupted" as const, endedAt: timestamp() }))
      const inputs = snapshot.inputs.filter(input => input.state === "dispatching").map(input => {
        const unsent = snapshot.turns.some(turn => turn.id === input.turnId && !turn.consumed)
        return { ...input, state: unsent ? "failed" as const : "uncertain" as const,
          error: unsent ? "Daemon restarted before provider dispatch" : "Daemon restarted before delivery was confirmed" }
      })
      const permissions = snapshot.permissions.filter(permission => permission.state === "pending")
        .map(permission => ({ ...permission, state: "cancelled" as const, resolvedAt: timestamp() }))
      const elicitations = snapshot.elicitations.filter(row => row.state === "pending")
        .map(({ completedAt: _completedAt, ...row }) => ({ ...row, state: "cancelled" as const, response: { action: "cancel" as const }, resolvedAt: timestamp() }))
      const recovered = session.lifecycle === "provisioning"
        ? { ...session, lifecycle: "provision_failed" as const, error: "Session creation was interrupted", updatedAt: timestamp() } : undefined
      const events = [
        ...runs.map(row => journal.event(session.id, "run", row)),
        ...turns.map(row => journal.event(session.id, "turn", row)),
        ...inputs.map(row => journal.event(session.id, "input", row)),
        ...permissions.map(row => journal.event(session.id, "permission", row)),
        ...elicitations.map(row => journal.event(session.id, "elicitation", row)),
        ...(recovered ? [journal.event(session.id, "session", recovered)] : []),
      ]
      if (events.length) await journal.commit(snapshot, { session: recovered, runs, turns, inputs, permissions, elicitations, events })
    })
  }
}
