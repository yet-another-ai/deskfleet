import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Usage } from "@agentclientprotocol/sdk/unstable"
import { connectAcpProcess, type AgentClient, type AgentConnection, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

const CONTINUATION_PROMPT =
  "Background command notification received. Continue the current task from the latest background command output without repeating already completed steps."

interface TranscriptStep {
  step_index?: number
  type?: string
  status?: string
  content?: string
  tool_calls?: { args?: Record<string, unknown> }[]
}

export type AntigravityTranscriptStatus = {
  state: "idle" | "running" | "waiting_interaction" | "settled_response"
  lastStepIndex: number
}

const isDaemon = (input: unknown): boolean =>
  typeof input === "object" && input !== null && [true, "true"].includes((input as { IsDaemon?: unknown }).IsDaemon as boolean)

const cleanId = (id: string): string => id.replace(/[.,;:]+$/, "")

function mergeUsage(a?: Usage | null, b?: Usage | null): Usage | undefined {
  if (!a || !b) return a ?? b ?? undefined
  const add = (x?: number | null, y?: number | null) => (x != null || y != null ? (x ?? 0) + (y ?? 0) : undefined)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedReadTokens: add(a.cachedReadTokens, b.cachedReadTokens),
    cachedWriteTokens: add(a.cachedWriteTokens, b.cachedWriteTokens),
    thoughtTokens: add(a.thoughtTokens, b.thoughtTokens),
  }
}

/** Inspects `transcript.jsonl` steps after `turnStartStepIndex` for active or settled background tasks. */
export function inspectAntigravityTranscript(raw: string, turnStartStepIndex: number): AntigravityTranscriptStatus {
  const running = new Set<string>()
  let plannerDaemon = false
  let lastRunning = -1
  let lastWakeup = -1
  let lastStep: TranscriptStep | undefined

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let step: TranscriptStep
    try { step = JSON.parse(line) as TranscriptStep } catch { continue }
    const idx = typeof step.step_index === "number" ? step.step_index : -1
    if (idx < 0) continue

    if (step.type === "PLANNER_RESPONSE") plannerDaemon = !!step.tool_calls?.some(c => isDaemon(c.args))
    if (idx > turnStartStepIndex) {
      const text = typeof step.content === "string" ? step.content : ""
      if (step.status === "RUNNING" && !plannerDaemon) {
        const id = text.match(/Tool is running as a background task with task id:\s*(\S+)/)?.[1]
        running.add(id ? cleanId(id) : `step-${idx}`)
        lastRunning = idx
      } else if (step.type === "SYSTEM_MESSAGE") {
        for (const id of [text.match(/sender=(\S+)/)?.[1], text.match(/Task id "([^"]+)"/)?.[1]]) {
          if (id) running.delete(cleanId(id))
        }
        lastWakeup = idx
      } else if (step.type === "GENERIC") {
        for (const m of text.matchAll(/Task "([^"]+)" cancelled\./g)) if (m[1]) running.delete(cleanId(m[1]))
        if (text.includes("No background tasks are currently running.")) running.clear()
      }
    }
    lastStep = step
  }

  const lastStepIndex = typeof lastStep?.step_index === "number" ? lastStep.step_index : -1
  if (!lastStep || lastStepIndex <= turnStartStepIndex) return { state: "idle", lastStepIndex }
  if (lastStep.status === "WAITING") return { state: "waiting_interaction", lastStepIndex }
  if (
    running.size === 0
    && lastWakeup > lastRunning
    && lastStepIndex > lastWakeup
    && lastStep.type === "PLANNER_RESPONSE"
    && lastStep.status === "DONE"
    && !lastStep.tool_calls?.length
  ) {
    return { state: "settled_response", lastStepIndex }
  }
  return { state: "running", lastStepIndex }
}

/** Wraps an Antigravity ACP client + connection to await backgrounded commands before ending the turn. */
export function createAntigravityClientWrapper(
  client: AgentClient,
  options: { dataDir?: string; pollIntervalMs?: number } = {},
) {
  const dataDir = options.dataDir ?? process.env.ANTIGRAVITY_CLI_DIR
    ?? join(process.env.GEMINI_HOME ?? join(homedir(), ".gemini"), "antigravity-cli")
  const pollMs = options.pollIntervalMs ?? 250
  const trackers = new Map<string, { pending: Set<string>; suppress: boolean; onFlush?: () => void }>()
  const aborts = new Map<string, AbortController>()

  const getTracker = (id: string) => {
    let t = trackers.get(id)
    if (!t) trackers.set(id, (t = { pending: new Set(), suppress: false }))
    return t
  }
  const readTranscript = (id: string) =>
    readFile(join(dataDir, "brain", id, ".system_generated", "logs", "transcript.jsonl"), "utf8").catch(() => null)

  const wrappedClient: AgentClient = {
    ...client,
    async onUpdate(notification) {
      const t = getTracker(notification.sessionId)
      const u = notification.update
      if (u.sessionUpdate === "tool_call" && typeof u.toolCallId === "string" && !isDaemon(u.rawInput)) {
        if (u.status === "completed" || u.status === "failed") t.pending.delete(u.toolCallId)
        else t.pending.add(u.toolCallId)
      } else if (u.sessionUpdate === "tool_call_update" && typeof u.toolCallId === "string" && (u.status === "completed" || u.status === "failed")) {
        t.pending.delete(u.toolCallId)
      }
      if (t.suppress) return
      await client.onUpdate(notification)
      t.onFlush?.()
    },
  }

  function wrapConnection(connection: AgentConnection): AgentConnection {
    return {
      ...connection,
      get initialization() { return connection.initialization },
      async prompt(params) {
        const { sessionId } = params
        const t = getTracker(sessionId)
        t.pending.clear()
        t.suppress = false
        const abort = new AbortController()
        aborts.set(sessionId, abort)
        const onAbort = () => abort.abort()
        client.signal?.addEventListener("abort", onAbort, { once: true })

        try {
          const initRaw = await readTranscript(sessionId)
          let startStep = initRaw ? inspectAntigravityTranscript(initRaw, Number.MAX_SAFE_INTEGER).lastStepIndex : -1
          let { stopReason, usage } = await connection.prompt(params)

          while (stopReason === "end_turn" && !abort.signal.aborted && t.pending.size > 0) {
            const startedAt = Date.now()
            let settled: AntigravityTranscriptStatus | undefined
            while (!abort.signal.aborted && Date.now() - startedAt < 30 * 60_000) {
              const raw = await readTranscript(sessionId)
              const s = raw ? inspectAntigravityTranscript(raw, startStep) : { state: "idle" as const, lastStepIndex: -1 }
              if (s.state === "idle" && Date.now() - startedAt >= pollMs * 8) break
              if (s.state === "waiting_interaction" || s.state === "settled_response") { settled = s; break }
              await delay(pollMs, undefined, { signal: abort.signal }).catch(() => {})
            }
            if (!settled || abort.signal.aborted) break

            const isSettled = settled.state === "settled_response"
            let timer: ReturnType<typeof setTimeout> | undefined
            if (isSettled) {
              t.onFlush = () => {
                if (t.pending.size > 0) return
                clearTimeout(timer)
                timer = setTimeout(() => {
                  t.suppress = true
                  void connection.cancel(sessionId).catch(() => {})
                }, Math.min(120, pollMs * 2))
              }
              t.onFlush()
            }
            try {
              startStep = settled.lastStepIndex
              const next = await connection.prompt({ sessionId, prompt: [{ type: "text", text: CONTINUATION_PROMPT }] })
              usage = mergeUsage(usage, next.usage)
              stopReason = isSettled ? "end_turn" : next.stopReason
            } finally {
              clearTimeout(timer)
              t.onFlush = undefined
              t.suppress = false
            }
            if (isSettled) break
          }
          return { stopReason: abort.signal.aborted ? "cancelled" : stopReason, ...(usage ? { usage } : {}) }
        } finally {
          client.signal?.removeEventListener("abort", onAbort)
          if (aborts.get(sessionId) === abort) aborts.delete(sessionId)
        }
      },
      async cancel(sessionId) {
        aborts.get(sessionId)?.abort()
        await connection.cancel(sessionId)
      },
    }
  }

  return { wrappedClient, wrapConnection }
}

/** Antigravity CLI serves ACP directly and uses its existing local credentials. */
export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  async connect(config, client) {
    const geminiDir = config.env?.GEMINI_HOME ?? process.env.GEMINI_HOME
    const dataDir = config.env?.ANTIGRAVITY_CLI_DIR ?? (geminiDir ? join(geminiDir, "antigravity-cli") : undefined)
    const args = geminiDir ? ["acp", "--gemini-dir", geminiDir] : ["acp"]
    const { wrappedClient, wrapConnection } = createAntigravityClientWrapper(client, { dataDir })
    return wrapConnection(await connectAcpProcess(launchProviderCommand(config.binaryPath || "agy", args, config.env), wrappedClient))
  },
}
