import type { AcpAvailableCommand, AgentComposerSkill } from "../../core/src/protocol.ts"

/** Pi advertises skills as `skill:<name>` commands. */
export function parsePiComposerSkill(command: AcpAvailableCommand): AgentComposerSkill | undefined {
  const { name, description } = command
  if (!name.startsWith("skill:") || name.length <= 6) return undefined
  return { id: name, name: name.slice(6), description, invocation: `/${name}` }
}
