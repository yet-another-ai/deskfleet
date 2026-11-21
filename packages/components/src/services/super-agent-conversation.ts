import type { SuperAgentMessage, SuperAgentTextPreview, SuperAgentTurn } from "@deskfleet/client/super-agent"
import type { ConversationEntry, ConversationInput } from "./agent-conversation.ts"

function inputEntry(message: SuperAgentMessage, state: "delivered" | "pending"): ConversationEntry {
  const content: ConversationInput["content"] = message.parts?.map(part => {
    if (part.kind === "text") return { type: "text", text: part.text }
    const name = part.filename || part.mediaType
    if (part.url && /^https?:\/\//iu.test(part.url)) {
      return { type: "resource_link", uri: part.url, name, mimeType: part.mediaType }
    }
    return { type: "text", text: name }
  }) ?? [{ type: "text", text: message.text }]
  return {
    kind: "input", id: `input-${message.id}`,
    input: {
      id: message.id, content, state, turnId: message.turnId, createdAt: message.at,
      author: { kind: "user", userId: message.senderId },
    },
  }
}

function assistantEntry(message: SuperAgentTextPreview): ConversationEntry {
  return { id: `message-${message.id}`, kind: "message", role: "assistant", turnId: message.turnId, content: [{ type: "text", text: message.text }] }
}

/** Adapt Eve history to the Session transcript without constructing a daemon Session. */
export function projectSuperAgentConversation(
  messages: readonly SuperAgentMessage[],
  pending: readonly SuperAgentMessage[],
  turns: readonly SuperAgentTurn[],
  previews: readonly SuperAgentTextPreview[] = [],
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  const byTurn = new Map(turns.map(turn => [turn.id, turn]))
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      entries.push(assistantEntry(message))
      continue
    }
    entries.push(inputEntry(message, "delivered"))
    // Keep the live or settled turn visible even if it has produced no reply yet.
    const next = messages[index + 1]
    if (!message.turnId || (next?.role === "user" && next.turnId === message.turnId)) continue
    const turn = byTurn.get(message.turnId)
    if (turn) entries.push({ id: `turn-${message.id}`, kind: "turn", turn })
  }
  entries.push(...previews.map(assistantEntry))
  entries.push(...pending.map(message => inputEntry(message, "pending")))
  return entries
}
