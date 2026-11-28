import { validComposerMentions, type ComposerFileReference, type ComposerMention, type ComposerReference, type ComposerSkillReference } from "@deskfleet/protocol/composer-reference"
import { validateComposerReference } from "../agent/composer-references.ts"
import type { AgentActor, AgentInput } from "@deskfleet/protocol/agent"
import { superHistoryExcerpt } from "./evidence.ts"
import type { SuperHistorySource } from "@deskfleet/protocol/super-agent"
import type { SuperRoom } from "./state.ts"
import type { SuperWorkers } from "./worker.ts"

export function workspaceMentions(text: string, value: unknown): ComposerMention[] | undefined {
  if (value === undefined || Array.isArray(value) && !value.length) return
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid composer mentions")
  const stringId = (s: unknown) => typeof s === "string" && !!s.length && s.length <= 512
  const mentions = value.map((m: ComposerMention) => {
    if (!m || !stringId(m.id) || !Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.end) || typeof m.token !== "string" || !m.reference) throw new Error("Invalid composer mention")
    const ref = m.reference
    if (ref.kind === "skill") {
      if (!stringId(ref.id) || !stringId(ref.name) || !stringId(ref.invocation) || !stringId(ref.providerId) || m.token !== `$${ref.name}`) throw new Error("Invalid selected skill")
    } else {
      validateComposerReference(ref)
      if (!m.token.startsWith("@") || ref.kind === "file" && m.token !== `@${ref.relativePath}`) throw new Error("Invalid selected reference")
    }
    return m
  })
  if (validComposerMentions(text, mentions).length !== mentions.length) throw new Error("A selected reference has changed. Select it again.")
  return mentions
}

export const selectedReferences = (mentions?: readonly ComposerMention[]): ComposerReference[] => mentions?.flatMap(m => m.reference.kind === "skill" ? [] : [m.reference]) ?? []
export const selectedSkills = (mentions?: readonly ComposerMention[]): ComposerSkillReference[] => mentions?.flatMap(m => m.reference.kind === "skill" ? [m.reference] : []) ?? []

/** Read only explicitly selected files and bounded Session excerpts in the current project. */
export async function workspaceReferenceEvidence(workers: SuperWorkers, actor: AgentActor, room: SuperRoom, refs: ComposerReference[], sources: SuperHistorySource[]) {
  const evidence: Extract<AgentInput["content"][number], { type: "resource" | "resource_link" }>[] = []
  const files = new Map<Extract<AgentInput["content"][number], { type: "resource_link" }>, ComposerFileReference>()
  if (!refs.length) return { evidence, files }
  const workspaceId = room.workspaceId ?? refs[0]!.workspaceId
  if (refs.some(ref => ref.workspaceId !== workspaceId)) throw new Error("References belong to a different workspace.")
  const fileSession = refs.find(ref => ref.kind === "file" && ref.sessionId)?.sessionId
  const owner = room.tickets.find(t => t.sessionId && t.executionWorkspaceId === workspaceId && (!fileSession || t.sessionId === fileSession))
  if (!room.workspaceId && !owner) throw new Error("Choose a Worker before referencing its private workspace.")
  const sessionId = fileSession ?? (!room.workspaceId ? owner?.sessionId : undefined)
  const resolved = await workers.handle("_deskfleet/composer/resolve", { workspaceId, sessionId, references: refs }, actor) as AgentInput["content"]
  for (const [index, ref] of refs.entries()) {
    const block = resolved[index]
    if (ref.kind === "file") {
      if (block?.type !== "resource_link") throw new Error("The referenced file could not be resolved.")
      evidence.push(block)
      files.set(block, ref)
    } else {
      if (block?.type !== "text") throw new Error("The referenced session could not be resolved.")
      const { session } = await workers.journal.read(ref.sessionId)
      if (session.workspaceId !== workspaceId) throw new Error("Referenced session changed workspace.")
      const through = BigInt(session.lastEventSeq)
      const after = String(through > 100n ? through - 100n : 0n)
      const events = await workers.journal.history(session.id, after, 100)
      const excerpt = superHistoryExcerpt(events.filter(event => BigInt(event.seq) <= through))
      const included = JSON.parse(excerpt) as { messages: unknown[]; nextAfterSeq?: string }
      if (included.messages.length && included.nextAfterSeq) sources.push({ sessionId: session.id, afterSeq: after, throughSeq: included.nextAfterSeq })
      evidence.push({ type: "resource", resource: { uri: `deskfleet://session/${session.id}`, mimeType: "text/plain",
        text: excerpt } })
    }
  }
  return { evidence, files }
}
