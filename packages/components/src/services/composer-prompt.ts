import type { AgentInput } from "../../../../apps/daemon/src/agent-protocol.ts"
import { composerSkillText, type ComposerReference } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
import { buildPromptContent } from "./composer-attachments.ts"
import { validComposerMentions, type ComposerMention } from "./composer-mentions.ts"

/** Resolve selected identities once, before the durable input is submitted. */
export async function buildComposerPrompt(params: Parameters<typeof buildPromptContent>[0] & {
  mentions: ComposerMention[]
  providerId: string
  resolveReferences(sessionId: string, references: ComposerReference[]): Promise<AgentInput["content"]>
}): Promise<AgentInput["content"]> {
  const mentions = validComposerMentions(params.draft, params.mentions)
  const draft = composerSkillText(params.draft, mentions, params.providerId)
  const references = mentions.flatMap(mention => mention.reference.kind === "skill" ? [] : [mention.reference])
  const resolved = references.length ? await params.resolveReferences(params.sessionId, references) : []
  const blocks = await buildPromptContent({ ...params, draft })
  return [...blocks, ...resolved]
}
