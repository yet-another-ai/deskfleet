import type { AgentInput } from "../../../../apps/daemon/src/agent-protocol.ts"
import type { ComposerReference } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
import { buildPromptContent } from "./composer-attachments.ts"
import { validComposerMentions, type ComposerMention } from "./composer-mentions.ts"

/** Resolve selected identities once, before the durable input is submitted. */
export async function buildComposerPrompt(params: Parameters<typeof buildPromptContent>[0] & {
  mentions: ComposerMention[]
  providerId: string
  resolveReferences(sessionId: string, references: ComposerReference[]): Promise<AgentInput["content"]>
}): Promise<AgentInput["content"]> {
  const mentions = validComposerMentions(params.draft, params.mentions)
  let draft = params.draft
  for (const mention of [...mentions].sort((left, right) => right.start - left.start)) {
    const reference = mention.reference
    if (reference.kind !== "skill") continue
    if (reference.providerId !== params.providerId) throw new Error("Select this skill again for the current Agent")
    if (reference.invocation.startsWith("/") && params.draft.slice(0, mention.start).trim()) {
      throw new Error("This Agent's skill must be placed at the start of the message")
    }
    draft = draft.slice(0, mention.start) + reference.invocation + draft.slice(mention.end)
  }
  const references = mentions.flatMap(mention => mention.reference.kind === "skill" ? [] : [mention.reference])
  const resolved = references.length ? await params.resolveReferences(params.sessionId, references) : []
  const blocks = await buildPromptContent({ ...params, draft })
  return [...blocks, ...resolved]
}
