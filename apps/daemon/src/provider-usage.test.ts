import assert from "node:assert/strict"
import test from "node:test"
import { runJsonLineExchange } from "./agent-usage.ts"
import { parseAntigravityUsage } from "./agents/antigravity.ts"
import { parseClaudeCodeUsage } from "./agents/claude-code.ts"
import { parseCodexUsage } from "./agents/codex.ts"
import { parseOmpUsage } from "./agents/omp.ts"

test("runJsonLineExchange drives a stdio JSON-line exchange, terminates lingering processes, and surfaces stderr", async () => {
  const script = `
    const readline = require("node:readline")
    const rl = readline.createInterface({ input: process.stdin })
    console.log("non-json startup banner")
    rl.on("line", line => {
      const msg = JSON.parse(line)
      if (msg.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))
      if (msg.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { items: ["done"] } }))
    })
    setInterval(() => {}, 10000)
  `
  const items = await runJsonLineExchange<string[]>({
    command: process.execPath,
    args: ["-e", script],
    env: process.env,
    timeoutMs: 5_000,
    start: send => send({ jsonrpc: "2.0", id: 1 }),
    onFrame(frame, send) {
      if (frame.id === 1) { send({ jsonrpc: "2.0", id: 2 }); return undefined }
      return frame.id === 2 ? (frame.result as { items: string[] }).items : undefined
    },
  })
  assert.deepEqual(items, ["done"])

  await assert.rejects(
    runJsonLineExchange({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("not logged in\\n"); process.exit(1)'],
      env: process.env,
      timeoutMs: 5_000,
      start() {},
      onFrame: () => undefined,
    }),
    /not logged in/,
  )

  await assert.rejects(
    runJsonLineExchange({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 10000)"],
      env: process.env,
      timeoutMs: 40,
      start() {},
      onFrame: () => undefined,
    }),
    /timed out after 40ms/,
  )
})

test("parseAntigravityUsage clamps remaining fractions and surfaces command errors", () => {
  const stdout = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", name: "Weekly Limit Remaining", remaining_fraction: 0.316, reset_time: "2026-11-14T05:07:24Z" },
              { id: "gemini-5h", name: "Five Hour Limit Remaining", remaining_fraction: 1.2 },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [{ id: "3p-5h", name: "Five Hour Limit Remaining", remaining_fraction: -0.1 }],
          },
        ],
      },
    },
  })
  assert.deepEqual(parseAntigravityUsage(stdout), [
    { id: "gemini-weekly", label: "Weekly Limit Remaining", group: "Gemini Models", remaining: 0.316, resetsAt: "2026-11-14T05:07:24Z" },
    { id: "gemini-5h", label: "Five Hour Limit Remaining", group: "Gemini Models", remaining: 1 },
    { id: "3p-5h", label: "Five Hour Limit Remaining", group: "Claude and GPT models", remaining: 0 },
  ])
  assert.throws(() => parseAntigravityUsage(JSON.stringify({ status: "ERROR", error: "Not signed in" })), /Not signed in/)
})

test("parseCodexUsage maps single and multi-bucket rate-limit windows", () => {
  assert.deepEqual(parseCodexUsage({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_763_000_000 },
      secondary: { usedPercent: 65, windowDurationMins: 10_080 },
      individualLimit: { remainingPercent: 80, resetsAt: 1_764_000_000 },
    },
  }), [
    { id: "codex:primary", label: "5h limit", remaining: 0.82, resetsAt: new Date(1_763_000_000 * 1000).toISOString() },
    { id: "codex:secondary", label: "Weekly limit", remaining: 0.35 },
    { id: "codex:spend", label: "Spend limit", remaining: 0.8, resetsAt: new Date(1_764_000_000 * 1000).toISOString() },
  ])

  assert.deepEqual(parseCodexUsage({
    rateLimitsByLimitId: {
      codex: { limitName: "Codex Plan", primary: { usedPercent: 25, windowDurationMins: 300 } },
      codex_spark: { primary: { usedPercent: 40, windowDurationMins: 60 } },
    },
  }), [
    { id: "codex:primary", label: "5h limit", group: "Codex Plan", remaining: 0.75 },
    { id: "codex_spark:primary", label: "1h limit", group: "codex_spark", remaining: 0.6 },
  ])
})

test("parseClaudeCodeUsage handles subscription windows, model-scoped precedence, and API-key accounts", () => {
  assert.deepEqual(parseClaudeCodeUsage({ rate_limits_available: false, rate_limits: null }), [])
  assert.deepEqual(parseClaudeCodeUsage({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 30, resets_at: "2026-11-12T18:00:00Z" },
      seven_day: { utilization: 55, resets_at: "2026-11-18T00:00:00Z" },
      model_scoped: [{ display_name: "Opus", utilization: 75, resets_at: "2026-11-18T00:00:00Z" }],
      seven_day_opus: { utilization: 99 },
      extra_usage: { is_enabled: true, utilization: 20 },
    },
  }), [
    { id: "five_hour", label: "5-hour limit", remaining: 0.7, resetsAt: "2026-11-12T18:00:00Z" },
    { id: "seven_day", label: "Weekly · all models", remaining: 0.45, resetsAt: "2026-11-18T00:00:00Z" },
    { id: "model:Opus", label: "Weekly · Opus", remaining: 0.25, resetsAt: "2026-11-18T00:00:00Z" },
    { id: "extra_usage", label: "Extra usage", remaining: 0.8 },
  ])
})

test("parseOmpUsage resolves fraction, ratio, percent, and remainingFraction amounts", () => {
  assert.deepEqual(parseOmpUsage(JSON.stringify({
    reports: [
      {
        provider: "Anthropic",
        limits: [
          { id: "5h", label: "5-hour window", amount: { usedFraction: 0.25 }, window: { resetsAt: 1_763_000_000_000 } },
          { id: "weekly", label: "Weekly quota", amount: { used: 300, limit: 1000 } },
        ],
      },
      {
        provider: "OpenAI",
        limits: [
          { id: "pct", label: "Percent bucket", amount: { used: 60, unit: "percent" } },
          { id: "rem", label: "Remaining bucket", amount: { remainingFraction: 0.15 } },
        ],
      },
    ],
  })), [
    { id: "0:5h", label: "5-hour window", group: "Anthropic", remaining: 0.75, resetsAt: new Date(1_763_000_000_000).toISOString() },
    { id: "0:weekly", label: "Weekly quota", group: "Anthropic", remaining: 0.7 },
    { id: "1:pct", label: "Percent bucket", group: "OpenAI", remaining: 0.4 },
    { id: "1:rem", label: "Remaining bucket", group: "OpenAI", remaining: 0.15 },
  ])
})
