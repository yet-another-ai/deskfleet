import type { ConversationTool } from "./agent-conversation.ts"

const remoteToolNames = [
  "deskfleet_remote_mcp_call",
  "deskfleet_remote_files",
  "deskfleet_remote_file_upload",
  "deskfleet_remote_file_download",
  "deskfleet_remote_session_create",
  "deskfleet_remote_session_send",
] as const
type RemoteToolName = (typeof remoteToolNames)[number]

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

function matchToolName(title: string | null | undefined): RemoteToolName | undefined {
  if (!title) return undefined
  return remoteToolNames.find(name =>
    title === name
    || new RegExp(`^mcp\\.[^.]+\\.${name}$`, "u").test(title)
    || new RegExp(`^(?:functions\\.)?mcp__.+__${name}$`, "u").test(title),
  )
}

function parseRemoteCall(tool: ConversationTool): Omit<RemoteMcpTool, "images" | "isError"> | undefined {
  const input = inputRecord(tool.rawInput)
  if (!input) return undefined
  // Codex wraps the MCP arguments; Claude and other ACP providers send them directly.
  const wrappedName = typeof input.tool === "string" && (remoteToolNames as readonly string[]).includes(input.tool)
    ? input.tool as RemoteToolName
    : undefined
  const kind = wrappedName ?? matchToolName(tool.title)
  const args = wrappedName ? inputRecord(input.arguments) : input
  const machineId = text(args?.machineId)
  if (!kind || !args || !machineId) return undefined
  if (kind === "deskfleet_remote_mcp_call") {
    const serverId = text(args.serverId), toolName = text(args.name), nested = inputRecord(args.arguments)
    if (!serverId || !toolName) return undefined
    return { machineId, serverId, toolName, action: text(nested?.command_id) ?? text(nested?.action) ?? text(nested?.operation) }
  }
  if (kind === "deskfleet_remote_files") {
    const operation = args.operation === undefined ? "list" : text(args.operation)
    const path = text(args.path)
    if ((operation !== "list" && operation !== "stat") || (operation === "stat" && !path)) return undefined
    return { machineId, serverId: "deskfleet", toolName: kind, action: path ? `${operation} ${path}` : operation }
  }
  if (kind === "deskfleet_remote_session_create") {
    const provider = text(args.provider)
    if (!provider) return undefined
    const label = text(args.title) ?? text(args.workspaceId)
    return { machineId, serverId: "deskfleet", toolName: kind, action: label ? `create ${provider} (${label})` : `create ${provider}` }
  }
  if (kind === "deskfleet_remote_session_send") {
    const sessionId = text(args.sessionId), prompt = text(args.prompt)
    if (!sessionId || !prompt) return undefined
    const delivery = text(args.delivery) === "steer" ? "steer" : "send"
    return { machineId, serverId: "deskfleet", toolName: kind, action: `${delivery} ${sessionId}` }
  }
  const sourcePath = text(args.sourcePath), destinationDirectory = text(args.destinationDirectory)
  if (!sourcePath || !destinationDirectory) return undefined
  const verb = kind === "deskfleet_remote_file_upload" ? "upload" : "download"
  return { machineId, serverId: "deskfleet", toolName: kind, action: `${verb} ${sourcePath} → ${destinationDirectory}` }
}

/** Cheap enough for activity grouping: only inspect identity and arguments, never image payloads. */
export function isRemoteMcpTool(tool: ConversationTool): boolean {
  return parseRemoteCall(tool) !== undefined
}

/** Normalize the published Codex/Claude ACP shapes without changing the original tool details. */
export function remoteMcpTool(tool: ConversationTool): RemoteMcpTool | undefined {
  const base = parseRemoteCall(tool)
  if (!base) return undefined
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
  const isError = tool.status === "failed" || result?.isError === true || output?.error != null
  return { ...base, images, isError }
}
