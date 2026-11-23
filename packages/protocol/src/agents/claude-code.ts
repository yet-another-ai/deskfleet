import type { AcpAvailableCommand, AgentComposerSkill } from "./core.ts"

/** claude-agent-acp marks confirmed skills via JetBrains Air command metadata. */
export function parseClaudeCodeComposerSkill(command: AcpAvailableCommand): AgentComposerSkill | undefined {
  const jetbrains = command._meta?.jetbrains
  const air = typeof jetbrains === "object" && jetbrains !== null && "air" in jetbrains ? jetbrains.air : undefined
  const confirmed = typeof air === "object" && air !== null
    && "kind" in air && air.kind === "skill" && "skillPath" in air && typeof air.skillPath === "string"
  if (!confirmed) return undefined
  return { id: command.name, name: command.name, description: command.description, invocation: `/${command.name}` }
}
