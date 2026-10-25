import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk"
import { agentConfiguration, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentCommand } from "./agent-protocol.ts"
import type { AgentJournal } from "./agent-store.ts"

/** Use the last confirmed provider choices, including after a daemon restart. */
export async function savedAgentConfiguration(journal: AgentJournal, sessionId: string): Promise<{
  options: SessionConfigOption[]; selection: AgentConfigurationSelection
}> {
  let end = BigInt((await journal.read(sessionId)).session.lastEventSeq)
  while (end > 0n) {
    const start = end > 200n ? end - 200n : 0n
    const events = await journal.history(sessionId, String(start), 200)
    for (const event of events.reverse()) {
      if (BigInt(event.seq) > end) continue
      if (event.kind === "acp") {
        const update = (event.payload as SessionNotification).update
        if (update.sessionUpdate === "config_option_update") {
          const configuration = agentConfiguration(update.configOptions)
          return { options: update.configOptions, selection: {
            model: configuration.models?.currentValue,
            reasoningEffort: configuration.reasoningEfforts?.currentValue,
            mode: configuration.modes?.currentValue,
          } }
        }
      }
      if (event.kind === "command") {
        const command = event.payload as AgentCommand
        if (command.method === "_deskfleet/session/create") return {
          options: [], selection: {
            model: command.params.model as string | undefined,
            reasoningEffort: command.params.reasoningEffort as string | undefined,
            mode: command.params.mode as string | undefined,
          },
        }
      }
    }
    end = start
  }
  return { options: [], selection: {} }
}
