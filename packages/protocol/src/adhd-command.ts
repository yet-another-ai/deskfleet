import type { AgentInput } from "./agent.ts"

export const adhdReplyMarker = "deskfleet/adhdReplyStyle"
export const adhdSkillName = "i-have-adhd"

/** Only an explicit, leading invocation changes the conversation's reply style. */
export function adhdCommand(text: string): { enabled: boolean; task: string } | undefined {
  const value = text.trim()
  if (/^(?:stop adhd mode|normal mode)$/iu.test(value)) return { enabled: false, task: "" }
  const match = /^[/$]i-have-adhd(?:\s+([\s\S]*))?$/iu.exec(value)
  if (match) return { enabled: true, task: match[1] ?? "" }
}

export function adhdToggleOnly(content: AgentInput["content"]): boolean {
  const block = content[0]
  if (content.length !== 1 || block?.type !== "text" || block._meta?.[adhdReplyMarker] || block._meta?.["deskfleet/composerProvider"]) return false
  const command = adhdCommand(block.text)
  return !!command && !command.task
}
