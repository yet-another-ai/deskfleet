import type { AgentConfiguration, AgentConfigurationParams } from "@deskfleet/protocol/agent-configuration"
import type { ComposerSkillReference } from "@deskfleet/protocol/composer-reference"
import { selectedSkills } from "./mentions.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { superWorkerCommandName, type SuperWorkerCommandTarget } from "@deskfleet/protocol/super-agent"
import { hasExplicitResumeIntent, stoppedTicketContinuationError, type SuperRouteResult } from "./router.ts"
import type { StoredSuperMessage, SuperRoom } from "./state.ts"
import type { SuperWorkers } from "./worker.ts"

export function sameCommandTarget(a?: SuperWorkerCommandTarget, b?: SuperWorkerCommandTarget) {
  return a?.provider === b?.provider && a?.ticketId === b?.ticketId && a?.sessionId === b?.sessionId
}

/** Discovery uses the same provider/Session configuration as the ordinary composer. */
export async function requireWorkerCommand(workers: SuperWorkers, actor: AgentActor, provider: string, name: string | undefined, skills: ComposerSkillReference[],
  target: { sessionId: string } | AgentConfigurationParams) {
  const configuration = ("sessionId" in target
    ? await workers.handle("_deskfleet/session/configuration", { ...target, composer: true }, actor)
    : await workers.handle("_deskfleet/agent/configuration", { ...target, composer: true, cache: true, includeMatrix: false }, actor)) as AgentConfiguration | null
  if (configuration?.provider?.id !== provider) throw new Error("The selected Worker provider has changed.")
  if (name && !configuration.commands?.some(command => command.name === name)) {
    throw new Error(`The selected worker does not offer /${name}. Check its current command menu.`)
  }
  for (const skill of skills) {
    if (skill.providerId !== provider || !configuration.skills?.some(item => item.id === skill.id && item.name === skill.name && item.invocation === skill.invocation)) throw new Error(`The selected worker does not offer $${skill.name}. Select the skill again.`)
  }
}

export async function routeWorkerCommand(workers: SuperWorkers, actor: AgentActor, room: SuperRoom, source: StoredSuperMessage,
  target: SuperWorkerCommandTarget, providers: readonly { id: string }[]): Promise<SuperRouteResult> {
  const name = superWorkerCommandName(source.text)
  const skills = selectedSkills(source.mentions)
  if (!name && !skills.length) throw new Error("Enter a worker slash command or select a skill.")
  if (!providers.some(p => p.id === target.provider)) throw new Error("The selected execution provider is unavailable.")
  const ticket = room.tickets.find(t => t.id === target.ticketId)
  if (target.ticketId && !ticket || target.sessionId && target.sessionId !== ticket?.sessionId) {
    throw new Error("The command target has changed. Select the worker command again.")
  }
  if (ticket?.sessionId) {
    const { session } = await workers.journal.read(ticket.sessionId)
    if (session.workspaceId !== (room.workspaceId ?? ticket.executionWorkspaceId) || !session.workspaceId || session.provider !== target.provider) {
      throw new Error("The command target has changed. Select the worker command again.")
    }
  } else {
    // Reject a stale draft catalog before allocating a Worker. The new Worker will
    // check its own catalog at delivery; project and execution directories can differ.
    await requireWorkerCommand(workers, actor, target.provider, name, skills, {
      provider: target.provider, workspaceId: room.workspaceId ?? undefined,
      ...(target.provider === room.provider && room.workerSelection),
    })
  }
  if (ticket?.status === "stopped" && !hasExplicitResumeIntent(source.text)) {
    throw new Error(stoppedTicketContinuationError)
  }
  return { reason: "Worker command", actions: [ticket
    ? { kind: "continue", ticketId: ticket.id, prompt: source.text, delivery: "backlog", ...(ticket.status === "stopped" && { resumeStopped: true }) }
    : { kind: "create", title: name ? `/${name}` : `$${skills[0]!.name}`, scope: source.text, prompt: source.text, provider: target.provider }] }
}
