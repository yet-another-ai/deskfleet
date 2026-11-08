import type { ConversationTool } from "./agent-conversation.ts"

export type ToolCallSummaryKind = "read" | "edit" | "delete" | "move" | "execute" | "search" | "fetch"
export interface ToolCallSummary { kind: ToolCallSummaryKind; target: string }

const summaryKinds = new Set<ToolCallSummaryKind>(["read", "edit", "delete", "move", "execute", "search", "fetch"])
const record = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined
const singleLine = (v: string) => v.replace(/\s+/gu, " ").trim()

function inputRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value)
  try { return record(JSON.parse(value)) } catch { return undefined }
}

function pick(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (input) for (const key of keys) { const value = text(input[key]); if (value) return value }
  return undefined
}

function unwrapShell(command: string): string {
  const match = command.trim().match(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-(?:l?c|cl)\s+(["'])([\s\S]+)\1$/u)
  if (!match) return singleLine(command)
  return singleLine(match[1] === "\"" ? match[2]!.replace(/\\(["\\$`])/gu, "$1") : match[2]!.replaceAll("'\\''", "'"))
}

export function shortenToolPath(rawPath: string, baseDir?: string): string {
  const path = rawPath.trim().replace(/^file:\/\/(?:localhost)?/iu, "").replaceAll("\\", "/")
  const base = baseDir?.replaceAll("\\", "/").replace(/\/+$/u, "")
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  return path.replace(/^.*?\/session-worktrees\/[^/]+\/repo-\d+\//u, "")
}

/** Extracts a concise human-readable action and target for collapsed tool call rows. */
export function toolCallSummary(tool: ConversationTool): ToolCallSummary | undefined {
  if (!tool.kind || !summaryKinds.has(tool.kind as ToolCallSummaryKind)) return undefined
  const input = inputRecord(tool.rawInput), action = record(input?.action)
  const kind: ToolCallSummaryKind = tool.kind === "search" && action?.type === "openPage" && text(action.url) ? "fetch" : tool.kind as ToolCallSummaryKind
  const cwd = pick(input, ["cwd", "Cwd", "working_dir", "workingDirectory"])
  if (kind === "move") {
    const from = pick(input, ["from", "old_path", "source_path"]) ?? tool.locations?.[0]?.path
    const to = pick(input, ["to", "new_path", "destination_path"]) ?? tool.locations?.[1]?.path
    return from && to ? { kind, target: `${shortenToolPath(from, cwd)} → ${shortenToolPath(to, cwd)}` } : undefined
  }
  if (kind === "read" || kind === "edit" || kind === "delete") {
    const diffs = tool.content?.flatMap(b => b.type === "diff" && text(b.path) ? [b.path] : []) ?? []
    const locs = tool.locations?.map(l => l.path).filter(Boolean) ?? []
    const raw = pick(input, ["file_path", "filePath", "absolute_path", "AbsolutePath", "target_file", "TargetFile", "path", "Path"])
    const source = diffs.length ? diffs : locs.length ? locs : raw ? [raw] : []
    const paths = [...new Set(source.map(p => shortenToolPath(p, cwd)).filter(Boolean))]
    return paths.length ? { kind, target: paths.join(", ") } : undefined
  }
  if (kind === "execute") {
    const raw = typeof tool.rawInput === "string" && !input ? text(tool.rawInput) : pick(input, ["command", "command_line", "CommandLine", "cmd"])
    return raw ? { kind, target: unwrapShell(raw) } : undefined
  }
  if (kind === "fetch") {
    const url = pick(input, ["url", "Url", "uri", "Uri"]) ?? text(action?.url)
    return url ? { kind, target: singleLine(url) } : undefined
  }
  const query = (typeof tool.rawInput === "string" && !input ? text(tool.rawInput) : undefined) ?? pick(input, ["query", "Query", "pattern", "Pattern", "glob"]) ?? text(action?.query)
  if (!query) return undefined
  const scope = pick(input, ["path", "Path", "directory", "SearchPath"])
  const shortScope = scope ? shortenToolPath(scope, cwd) : undefined
  return { kind, target: shortScope && shortScope !== "." ? `${singleLine(query)} (${shortScope})` : singleLine(query) }
}
