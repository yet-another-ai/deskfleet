import type { AcpAvailableCommand, AgentComposerSkill } from "./core.ts"

/** codex-acp advertises skills with a literal "$" prefix. */
export function parseCodexComposerSkill(command: AcpAvailableCommand): AgentComposerSkill | undefined {
  const { name, description } = command
  if (!name.startsWith("$") || name.length <= 1) return undefined
  return { id: name, name: name.slice(1), description, invocation: name }
}
