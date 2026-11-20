import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"

export function validateAgentContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("A message is required")
  let hasText = false
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Only nonempty text messages are supported")
    const block = item as Record<string, unknown>
    if (block.type === "text") {
      if (typeof block.text !== "string" || !block.text.trim()) throw new Error("Only nonempty text messages are supported")
      hasText = true
      continue
    }
    if (block.type === "image") {
      if (typeof block.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/iu.test(block.mimeType)
        || typeof block.data !== "string" || !block.data.length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(block.data)) {
        throw new Error("Invalid image attachment")
      }
      continue
    }
    if (block.type === "resource") {
      const resource = block.resource
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) throw new Error("Invalid text resource attachment")
      const record = resource as Record<string, unknown>
      if (typeof record.uri !== "string" || !record.uri.length || record.uri.length > 2048 || record.uri.includes("\0")
        || typeof record.text !== "string" || !record.text.trim()
        || (record.mimeType !== undefined && record.mimeType !== null && (typeof record.mimeType !== "string" || !record.mimeType.length || record.mimeType.length > 256))) {
        throw new Error("Invalid text resource attachment")
      }
      hasText = true
      continue
    }
    if (block.type === "resource_link") {
      if (typeof block.uri !== "string" || !/^file:\/\/\//iu.test(block.uri) || block.uri.length > 4096 || block.uri.includes("\0")
        || typeof block.name !== "string" || !block.name.trim() || block.name.length > 512 || block.name.includes("\0")
        || (block.mimeType !== undefined && block.mimeType !== null && (typeof block.mimeType !== "string" || !block.mimeType.length || block.mimeType.length > 256))
        || (block.size !== undefined && block.size !== null && (typeof block.size !== "number" || !Number.isSafeInteger(block.size) || block.size < 0))) {
        throw new Error("Invalid file attachment")
      }
      continue
    }
    throw new Error("Only nonempty text messages are supported")
  }
  if (!hasText) throw new Error("Only nonempty text messages are supported")
  return value as ContentBlock[]
}
