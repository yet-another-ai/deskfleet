import type { AvailableCommand, SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import { agentConfiguration, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentCommand, AgentRun } from "./agent-protocol.ts"
import type { AgentJournal } from "./agent-store.ts"

/** Use the last confirmed provider choices, including after a daemon restart. */
export async function savedAgentConfiguration(journal: AgentJournal, sessionId: string): Promise<{
  options: SessionConfigOption[]; selection: AgentConfigurationSelection; commands?: AvailableCommand[]
}> {
  const snapshot = await journal.read(sessionId)
  const generation = Math.max(0, ...snapshot.runs.map(run => run.generation))
  let end = BigInt(snapshot.session.lastEventSeq)
  let configuration: { options: SessionConfigOption[]; selection: AgentConfigurationSelection } | undefined
  let commands: AvailableCommand[] | undefined
  let commandsResolved = false
  while (end > 0n) {
    const start = end > 200n ? end - 200n : 0n
    const events = await journal.history(sessionId, String(start), 200)
    for (const event of events.reverse()) {
      if (BigInt(event.seq) > end) continue
      if (event.kind === "acp") {
        const update = (event.payload as SessionNotification).update
        if (update.sessionUpdate === "available_commands_update" && !commandsResolved && event.runGeneration === generation) {
          commands = update.availableCommands
          commandsResolved = true
        }
        if (update.sessionUpdate === "config_option_update" && !configuration) {
          const selected = agentConfiguration(update.configOptions)
          configuration = { options: update.configOptions, selection: {
            model: selected.models?.currentValue,
            reasoningEffort: selected.reasoningEfforts?.currentValue,
            mode: selected.modes?.currentValue,
          } }
        }
      }
      // A fresh provider process must advertise its own command catalog. Old
      // commands can disappear after configuration or skill changes.
      if (event.kind === "run" && (event.payload as AgentRun).generation === generation
        && (event.payload as AgentRun).state === "starting") commandsResolved = true
      if (event.kind === "command") {
        const command = event.payload as AgentCommand
        // Creation completes after the first provider catalog is recorded. Only
        // its original accepted command is a fallback when no catalog exists.
        if (!configuration && command.method === "_deskfleet/session/create" && command.isCanonical && command.status === "accepted") configuration = {
          options: [], selection: {
            model: command.params.model as string | undefined,
            reasoningEffort: command.params.reasoningEffort as string | undefined,
            mode: command.params.mode as string | undefined,
          },
        }
      }
      if (configuration && commandsResolved) return { ...configuration, ...(commands ? { commands } : {}) }
    }
    end = start
  }
  return { ...(configuration ?? { options: [], selection: {} }), ...(commands ? { commands } : {}) }
}
