import type { SuperCoordinatorUsage } from "./super-agent-protocol.ts"

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function measured(used: number, size?: number): SuperCoordinatorUsage | undefined {
  if (!tokens(used) || !used) return
  return size && tokens(size) ? { used, size } : { used }
}

/** Each restricted Codex exec starts a fresh thread and makes a single tool-free turn.
 * Its input and output totals already include cached input and reasoning respectively. */
export function codexSuperUsage(stdout: string, entry: unknown): SuperCoordinatorUsage | undefined {
  const model = object(entry)
  const window = model?.context_window
  const percent = model?.effective_context_window_percent
  const size = tokens(window) && tokens(percent) && percent > 0 && percent <= 100 ? Math.floor(window * percent / 100) : undefined
  for (const line of stdout.trimEnd().split("\n").reverse()) {
    let frame: Record<string, unknown> | undefined
    try { frame = object(JSON.parse(line)) } catch { continue }
    if (frame?.type !== "turn.completed") continue
    const usage = object(frame.usage)
    if (!tokens(usage?.input_tokens) || !tokens(usage?.output_tokens)) return
    return measured(usage.input_tokens + usage.output_tokens, size)
  }
}

/** Claude's result.usage and result.modelUsage counters can sum several inference calls.
 * Use the most recent top-level assistant message and only its exact model's published capacity. */
export function claudeSuperUsage(frames: unknown[]): SuperCoordinatorUsage | undefined {
  const events = frames.map(object)
  const result = events.findLast(frame => frame?.type === "result")
  const last = events.findLast(frame => frame?.type === "assistant" && !frame.parent_tool_use_id
    && typeof object(frame.message)?.model === "string" && object(frame.message)?.model !== "<synthetic>")
  const message = object(last?.message)
  const usage = object(message?.usage)
  if (!usage || !tokens(usage.input_tokens) || !tokens(usage.output_tokens)) return
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  if (!tokens(cacheRead) || !tokens(cacheWrite)) return
  const model = typeof message?.model === "string" ? object(object(result?.modelUsage)?.[message.model]) : undefined
  const size = model?.contextWindow
  return measured(usage.input_tokens + cacheRead + cacheWrite + usage.output_tokens, tokens(size) ? size : undefined)
}
