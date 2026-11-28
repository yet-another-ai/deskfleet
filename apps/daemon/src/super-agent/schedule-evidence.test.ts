import assert from "node:assert/strict"
import test from "node:test"
import type { AgentEvent, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpRunRecord } from "@deskfleet/protocol/super-agent-follow-up"
import { formatRunEvidenceLine, inspectScheduleRunsWithEvidence } from "./schedule-evidence.ts"
import type { SuperWorkers } from "./worker.ts"
import { triageFollowUpEvent } from "./triage.ts"

function mockJournal(snapshot: AgentSnapshot, events: AgentEvent[], opts: { maxHistoryItems?: number } = {}): SuperWorkers["journal"] {
  return {
    identity: { originId: "origin-1", machineId: "machine-1" },
    list: async () => [snapshot.session],
    read: async () => snapshot,
    history: async (_sessionId: string, afterSeq: string, limit = 200) => {
      const start = BigInt(afterSeq)
      const filtered = events.filter(event => BigInt(event.seq) > start)
      const capped = opts.maxHistoryItems !== undefined ? filtered.slice(0, Math.min(limit, opts.maxHistoryItems)) : filtered.slice(0, limit)
      return capped
    },
    command: async () => undefined,
  } as unknown as SuperWorkers["journal"]
}

const baseTask: ScheduledTask = {
  id: "sched-1",
  title: "Nightly Audit",
  prompt: "Audit logs",
  workspaceId: "ws-1",
  enabled: true,
  target: { kind: "new", provider: "codex", context: "directory" },
  trigger: { kind: "manual" },
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  runs: [{
    id: "run-1",
    state: "completed",
    scheduledFor: "2026-11-20T01:00:00.000Z",
    startedAt: "2026-11-20T01:00:00.000Z",
    finishedAt: "2026-11-20T01:05:00.000Z",
    sessionId: "10",
    inputId: "in-1",
  }],
}

const baseSnapshot: AgentSnapshot = {
  session: {
    id: "10",
    workspaceId: "ws-1",
    provider: "codex",
    context: "directory",
    title: "Nightly Audit",
    lifecycle: "ready",
    archiveState: "active",
    createdAt: "2026-11-20T01:00:00.000Z",
    updatedAt: "2026-11-20T01:05:00.000Z",
    lastEventSeq: "10",
  },
  runs: [],
  inputs: [{
    id: "in-1",
    sessionId: "10",
    submissionCommandId: "cmd-1",
    acceptedSeq: "1",
    author: { kind: "user", userId: "alice", deviceId: "dev-1" },
    requestedDelivery: "backlog",
    state: "delivered",
    turnId: "turn-1",
    content: [{ type: "text", text: "Audit logs" }],
    createdAt: "2026-11-20T01:00:00.000Z",
  }],
  turns: [{
    id: "turn-1",
    sessionId: "10",
    initialInputId: "in-1",
    dispatchCommandId: "cmd-1",
    runGeneration: 1,
    state: "completed",
    startedAt: "2026-11-20T01:00:01.000Z",
    endedAt: "2026-11-20T01:05:00.000Z",
  }],
  permissions: [],
  elicitations: [],
}

test("D4b: persisted partial summary never fast-paths to concluded; falls back to exact turn and marks incomplete when transcript is truncated", async () => {
  const persisted: FollowUpRunRecord = {
    id: "rec-1",
    userId: "alice",
    workspaceId: "ws-1",
    sourceKind: "schedule",
    sourceId: "sched-1",
    runKey: "run:run-1",
    runId: "run-1",
    status: "completed",
    startedAt: "2026-11-20T01:00:00.000Z",
    finishedAt: "2026-11-20T01:05:00.000Z",
    sessionId: "10",
    inputId: "in-1",
    turnId: "turn-1",
    deliveryPolicy: "every_run",
    delivered: true,
    evidenceAvailability: "partial",
    summary: 'Partial output captured for "Nightly Audit" (full transcript exceeded read limit; open the original execution session for complete details):\n\nChecking step 1...',
    createdAt: "2026-11-20T01:05:01.000Z",
    updatedAt: "2026-11-20T01:05:01.000Z",
  }

  // Create 5 events but force historyMaxPages=1 and historyPageSize=2 so read.complete === false.
  const events: AgentEvent[] = [1, 2, 3, 4, 5].map(seq => ({
    seq: String(seq),
    sessionId: "10",
    turnId: "turn-1",
    kind: "acp",
    createdAt: `2026-11-20T01:0${seq}:00.000Z`,
    payload: {
      sessionId: "10",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Chunk ${seq}` },
      },
    },
  }))

  const results = await inspectScheduleRunsWithEvidence({
    userId: "alice",
    task: baseTask,
    persistedRuns: [persisted],
    journal: mockJournal(baseSnapshot, events),
    historyPageSize: 2,
    historyMaxPages: 1,
  })

  assert.equal(results.length, 1)
  const item = results[0]!
  assert.equal(item.evidenceAvailability, "partial")
  assert.equal(item.evidenceStatus, "incomplete")
  assert.equal(item.conclusion, undefined)
  assert.match(item.error ?? "", /incomplete|could not be read completely/iu)
  assert.match(formatRunEvidenceLine(item), /Incomplete evidence — no confirmed conclusion/u)
})

test("D4b: persisted partial run recovers a real conclusion when full turn transcript is now completely readable", async () => {
  const persisted: FollowUpRunRecord = {
    id: "rec-2",
    userId: "alice",
    workspaceId: "ws-1",
    sourceKind: "schedule",
    sourceId: "sched-1",
    runKey: "run:run-1",
    runId: "run-1",
    status: "completed",
    startedAt: "2026-11-20T01:00:00.000Z",
    finishedAt: "2026-11-20T01:05:00.000Z",
    sessionId: "10",
    inputId: "in-1",
    turnId: "turn-1",
    deliveryPolicy: "every_run",
    delivered: true,
    evidenceAvailability: "partial",
    summary: '"Nightly Audit" finished, but its full turn transcript could not be read completely. Open the original execution session to inspect the complete output.',
    createdAt: "2026-11-20T01:05:01.000Z",
    updatedAt: "2026-11-20T01:05:01.000Z",
  }

  const events: AgentEvent[] = [{
    seq: "1",
    sessionId: "10",
    turnId: "turn-1",
    kind: "acp",
    createdAt: "2026-11-20T01:04:00.000Z",
    payload: {
      sessionId: "10",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All 42 checks passed with 0 errors." },
      },
    },
  }]

  const results = await inspectScheduleRunsWithEvidence({
    userId: "alice",
    task: baseTask,
    persistedRuns: [persisted],
    journal: mockJournal(baseSnapshot, events),
  })

  assert.equal(results.length, 1)
  const item = results[0]!
  assert.equal(item.evidenceAvailability, "available")
  assert.equal(item.evidenceStatus, "concluded")
  assert.equal(item.conclusion, "All 42 checks passed with 0 errors.")
  assert.equal(item.summarySource, "run_turn_evidence")
})

test("D4b: triage marks incomplete transcript runs as reportDelivered=false", async () => {
  const decision = await triageFollowUpEvent({
    userId: "alice",
    ruleMode: "active",
    sourceKind: "schedule",
    sourceId: "sched-1",
    sourceTitle: "Nightly Audit",
    workspaceId: "ws-1",
    runKey: "run:run-1",
    status: "completed",
    deliveryPolicy: "every_run",
    outputText: "Partial text",
    evidenceIncomplete: true,
  })
  assert.equal(decision.kind, "deliver_result")
  assert.equal(decision.reportDelivered, false)
})
