import { computed, type Ref } from "vue"
import type { ConversationInput, ConversationStep, TranscriptEntry } from "../services/agent-conversation.ts"
import { scrollingToConversationEntry } from "../services/conversation-locate.ts"
import { pendingMermaidLocate } from "../stores/layout.ts"
import { pendingPreviewLocate } from "../stores/previews.ts"

function matchesBlock(block: ConversationInput["content"][number], content: string, markdown: boolean) {
  switch (block.type) {
    case "text": return markdown && block.text.includes(content)
    case "resource_link": return block.uri === content
    case "image":
    case "audio": return content === `data:${block.mimeType};base64,${block.data}`
    default: return false
  }
}

function locateStep(step: ConversationStep, id: string | undefined, content: string | undefined): string | undefined {
  if (id && step.id === id) return id
  if (step.kind === "subagent") {
    for (const child of step.steps) {
      const result = locateStep(child, id, content)
      if (result) return result
    }
  }
  if (id || !content) return
  if (step.kind === "structured_plan") return step.plan.type === "markdown" && step.plan.content.includes(content) ? step.id : undefined
  if (step.kind === "tool") return step.tool.content?.some(block => block.type === "content" && matchesBlock(block.content, content, false)) ? step.id : undefined
  const blocks = step.kind === "message" ? step.content : step.kind === "compaction" ? step.compaction.summary : step.kind === "session_message" ? step.message.content : undefined
  return blocks?.some(block => matchesBlock(block, content, true)) ? step.id : undefined
}

/** Resolve the row and its nested entry before the scroll target exists in the DOM. */
export function useTranscriptLocate(entries: Readonly<Ref<TranscriptEntry[]>>, sessionId: Readonly<Ref<string | undefined>>, focusedEntry: () => string | undefined) {
  return computed(() => {
    const pending = pendingPreviewLocate.value ?? pendingMermaidLocate.value ?? scrollingToConversationEntry.value
    const target = pending && (!pending.sessionId || pending.sessionId === sessionId.value) ? pending : undefined
    const id = target?.entryId ?? (target ? undefined : focusedEntry())
    let content: string | undefined
    if (target && "code" in target) content = target.code
    if (target && "content" in target) {
      content = target.content.startsWith("blob:") && target.itemId ? target.itemId : target.content
    }
    if (!id && !content) return
    for (const row of entries.value) {
      if (row.kind === "input") {
        if (id === row.id || (!id && content && row.input.content.some(block => matchesBlock(block, content, false)))) {
          return { rowId: row.id, entryId: row.id }
        }
      } else {
        for (const step of row.steps) {
          const entryId = locateStep(step, id, content)
          if (entryId) return { rowId: row.id, entryId }
        }
      }
    }
  })
}
