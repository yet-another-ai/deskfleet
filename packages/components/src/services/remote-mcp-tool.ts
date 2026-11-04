import type { ConversationTool } from "./agent-conversation.ts"

const remoteToolName = "deskfleet_remote_mcp_call"

export interface RemoteMcpImage {
  data: string
  mimeType: string
}

export interface RemoteMcpTool {
  machineId: string
  serverId: string
  toolName: string
  action?: string
  images: RemoteMcpImage[]
  isError: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function inputRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value)
  try { return record(JSON.parse(value)) } catch { return undefined }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function remoteInput(tool: ConversationTool): Record<string, unknown> | undefined {
  const input = inputRecord(tool.rawInput)
  if (!input) return undefined
  // Codex wraps the MCP arguments; Claude and other ACP providers send them directly.
  const wrapped = input.tool === remoteToolName ? inputRecord(input.arguments) : undefined
  const named = tool.title === remoteToolName
    || /^mcp\.[^.]+\.deskfleet_remote_mcp_call$/u.test(tool.title ?? "")
    || /^(?:functions\.)?mcp__.+__deskfleet_remote_mcp_call$/u.test(tool.title ?? "")
  const args = wrapped ?? (named ? input : undefined)
  return args && text(args.machineId) && text(args.serverId) && text(args.name) ? args : undefined
}

/** Cheap enough for activity grouping: only inspect identity and arguments, never image payloads. */
export function isRemoteMcpTool(tool: ConversationTool): boolean {
  return remoteInput(tool) !== undefined
}

/** Normalize the published Codex/Claude ACP shapes without changing the original tool details. */
export function remoteMcpTool(tool: ConversationTool): RemoteMcpTool | undefined {
  const input = remoteInput(tool)
  if (!input) return undefined
  const args = inputRecord(input.arguments)
  const output = record(tool.rawOutput)
  const result = record(output?.result) ?? output
  const images: RemoteMcpImage[] = []
  const seen = new Map<string, Set<string>>()
  function addImage(value: unknown): void {
    const block = record(value)
    if (block?.type !== "image") return
    const source = record(block.source)
    const data = typeof block.data === "string" ? block.data : source?.type === "base64" ? source.data : undefined
    const mimeType = text(block.mimeType) ?? (source?.type === "base64" ? text(source.media_type) : undefined)
    if (typeof data !== "string" || !data || !mimeType || !/^image\/[a-z0-9.+-]+$/iu.test(mimeType)) return
    let payloads = seen.get(mimeType)
    if (!payloads) { payloads = new Set(); seen.set(mimeType, payloads) }
    if (payloads.has(data)) return
    payloads.add(data)
    images.push({ data, mimeType })
  }
  for (const block of tool.content ?? []) if (block.type === "content") addImage(block.content)
  const rawContent = Array.isArray(tool.rawOutput) ? tool.rawOutput : result?.content
  if (Array.isArray(rawContent)) for (const block of rawContent) addImage(block)
  return {
    machineId: input.machineId as string,
    serverId: input.serverId as string,
    toolName: input.name as string,
    // AUV's invoke uses command_id; op_run uses operation. Other tools may expose action.
    action: text(args?.command_id) ?? text(args?.action) ?? text(args?.operation),
    images,
    isError: tool.status === "failed" || result?.isError === true || output?.error != null,
  }
}
