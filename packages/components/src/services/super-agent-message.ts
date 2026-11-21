import type { SuperAgentMessageContent, SuperAgentMessagePart } from "@deskfleet/client/super-agent"
import { bytesToBase64, type ComposerAttachment } from "./composer-attachments.ts"

/** Prepare hosted deliveries in the same order as machine Session prompts. */
export function buildSuperAgentMessage(draft: string, attachments: readonly ComposerAttachment[]): SuperAgentMessageContent {
  const text = draft.trim()
  if (!attachments.length) return text
  const parts: SuperAgentMessagePart[] = attachments.map(item => {
    switch (item.kind) {
      case "pasted_text":
        return { type: "text", text: item.text }
      case "image":
        return { type: "file", filename: item.name, mediaType: item.mimeType, data: item.data }
      case "local_file":
        return { type: "file", filename: item.name, mediaType: item.mimeType || "application/octet-stream", data: bytesToBase64(item.bytes) }
      default:
        throw new Error("Hosted Sessions only accept local files and pasted text")
    }
  })
  if (text) parts.push({ type: "text", text })
  return parts
}
