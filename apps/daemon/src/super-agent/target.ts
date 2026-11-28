import { resolve } from "node:path"
import type { AgentActor } from "@deskfleet/protocol/agent"
import type { GitStatusSnapshot } from "@deskfleet/protocol/git"
import { hasExplicitResumeIntent, stoppedTicketContinuationError, type SuperRouteResult } from "./router.ts"
import type { SuperWorkspace } from "@deskfleet/protocol/super-agent"
import { errorText, type SuperRoom } from "./state.ts"
import { activeTurn, type SuperWorkers } from "./worker.ts"
import type { WorkerReference } from "@deskfleet/client/worker-reference"

export class HistoricalSessionUnavailable extends Error {
  readonly sessionId: string
  constructor(sessionId: string, message: string) { super(message); this.sessionId = sessionId }
}
export async function inspectHistoricalWorker(workers: SuperWorkers, sessionId: string, workspace: SuperWorkspace, actor: AgentActor) {
  const snapshot = await workers.journal.read(sessionId)
  if (snapshot.session.workspaceId !== workspace.id) throw new Error("Historical worker is outside this workspace")
  if (snapshot.turns.some(activeTurn) || snapshot.inputs.some(input => ["uncertain", "dispatching", "pending"].includes(input.state))) throw new HistoricalSessionUnavailable(sessionId, "Historical session is busy or its input state is unknown. Inspect that session first.")
  if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") throw new HistoricalSessionUnavailable(sessionId, "Historical session is archived or unavailable. Inspect or restore the original session.")
  if (!await ownedByActor(workers, sessionId, actor)) {
    throw new HistoricalSessionUnavailable(sessionId, "The original worker has a different or unknown owner. Open the session to inspect its history.")
  }
  let git: GitStatusSnapshot
  try { git = await workers.handle("_deskfleet/git/status", { sessionId, force: true }, actor) as GitStatusSnapshot }
  catch (error) { throw new HistoricalSessionUnavailable(sessionId, `The original checkout cannot be inspected: ${errorText(error)}`) }
  const roots = workspace.roots
  const changedDirectory = snapshot.session.context === "directory" && !git.directories.every(dir => roots.some(root => resolve(root) === resolve(dir.path)))
  const missingWorktree = snapshot.session.context === "worktree" && git.directories.some(dir => !dir.repositoryId)
  if (!git.directories.length || changedDirectory || missingWorktree || git.directories.some(dir => dir.error) || git.repositories.some(repo => repo.error || repo.changes.length)) {
    throw new HistoricalSessionUnavailable(sessionId, "The original checkout has changes or its directories cannot be verified. Open the original session to inspect the work before continuing.")
  }
  return snapshot.session
}
export async function ownedByActor(workers: SuperWorkers, sessionId: string, actor: AgentActor) {
  const creation = (await workers.journal.commands(sessionId)).find(command =>
    command.isCanonical && (command.method === "_deskfleet/session/create" || command.method === "_deskfleet/session/fork"))
  return actor.kind === "user" && !!actor.userId && creation?.actor.kind === "user" && creation.actor.userId === actor.userId
}

export interface WorkerRegistration { teamId?: string; machineId?: string; revoked?: boolean }

export async function resolveWorkerTarget({ target, prompt, actor, registration, workers, providers, room, workspaces, projects, quotedTicketId, correctedTicketId, quoteText }: {
  target: WorkerReference; prompt: string; actor: AgentActor; registration?: WorkerRegistration; workers: SuperWorkers; providers: { id: string }[]
  room: SuperRoom; workspaces: SuperWorkspace[]; projects: SuperWorkspace[]; quotedTicketId?: string; correctedTicketId?: string; quoteText?: string
}): Promise<{ decision: SuperRouteResult; historicalWorkspace?: SuperWorkspace }> {
  if (!registration || registration.revoked || registration.teamId !== target.teamId || registration.machineId !== target.machineId) {
    throw new Error("This worker ID is for a different team or machine. Open its project on the original machine.")
  }
  const { session } = await workers.journal.read(target.sessionId)
  const workspace = workspaces.find(item => item.id === session.workspaceId)
  if (!workspace || session.id !== target.sessionId || (room.workspaceId !== null && room.workspaceId !== workspace.id)) {
    throw new Error("This worker does not belong to this project. Open the worker's own project.")
  }
  if (!await ownedByActor(workers, session.id, actor)) throw new Error("The selected worker has a different or unknown owner.")
  if (session.archiveState !== "active" || session.lifecycle !== "ready") {
    throw new HistoricalSessionUnavailable(session.id, "The selected worker is archived or unavailable. Inspect or restore the original session.")
  }
  if (!providers.some(provider => provider.id === session.provider)) throw new Error("The selected worker’s provider is unavailable. Restore it, then retry.")
  const ticket = room.tickets.find(item => item.sessionId === session.id)
  if ([quotedTicketId, correctedTicketId].some(id => id && id !== ticket?.id)) {
    throw new Error("The selected worker and the quoted or corrected ticket disagree. Choose a single target.")
  }
  const reason = "The user selected this worker by ID."
  if (room.workspaceId === null && projects.some(project => project.id === workspace.id)) {
    if (quotedTicketId || correctedTicketId) throw new Error("The selected project worker conflicts with the ticket in the default workspace.")
    return { decision: { reason, actions: [{ kind: "handoff", workspaceId: workspace.id, prompt, context: quoteText ? quoteText.slice(0, 5000) : "" }] } }
  }
  if (ticket) {
    if (ticket.executionWorkspaceId && ticket.executionWorkspaceId !== workspace.id) throw new Error("The ticket's execution workspace has changed.")
    if (ticket.status === "stopped" && !hasExplicitResumeIntent(prompt)) throw new Error(stoppedTicketContinuationError)
    return { decision: { reason, actions: [{ kind: "continue", ticketId: ticket.id, prompt, delivery: "backlog", ...(ticket.status === "stopped" && { resumeStopped: true }) }] } }
  }
  return { decision: { reason, actions: [{ kind: "create", sessionId: session.id, title: session.title || prompt.slice(0, 100), scope: prompt, prompt }] }, historicalWorkspace: workspace }
}
