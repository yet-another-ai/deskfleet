import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isConfirmedStoppedTurn,
  parseSuperReusedAttachments,
  resolveSupersededStoppedTurns,
  type SuperMessage,
  type SuperTicket,
} from "./super-agent.ts"

const msg = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id,
  role: "user",
  text: id,
  createdAt: "2026-11-28T00:00:00.000Z",
  ...extra,
})

const ticket = (id: string, extra: Partial<SuperTicket> = {}): SuperTicket => ({
  id,
  title: id,
  scope: id,
  summary: "",
  provider: "codex",
  updatedAt: "2026-11-28T00:00:00.000Z",
  ...extra,
})

test("isConfirmedStoppedTurn accepts only durably confirmed stopped turns", () => {
  const t1 = ticket("t1", { title: "Task 1", status: "stopped" })
  const t2 = ticket("t2", { title: "Task 2", status: "working" })

  // 1) Stopped during routing
  assert.equal(isConfirmedStoppedTurn([msg("u-stopped", { state: "stopped" })], [], "u-stopped"), true)
  // Blocked if local stop is still pending
  assert.equal(
    isConfirmedStoppedTurn([msg("u-stopped", { state: "stopped" })], [], "u-stopped", { hasPendingLocalStop: true }),
    false,
  )

  // 2) Active / non-stopped user states
  for (const state of ["routing", "answered", "failed", "uncertain", "transferred"] as const) {
    assert.equal(isConfirmedStoppedTurn([msg("u", { state })], [], "u"), false)
  }

  // 3) Dispatched and confirmed stopped before worker result
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-disp", { state: "assigned", ticketId: "t1" }),
        msg("d-1", { role: "assistant", kind: "dispatch", sourceMessageId: "u-disp", ticketId: "t1", stopState: "stopped" }),
      ],
      [t1],
      "u-disp",
    ),
    true,
  )

  // 4) Stopping / unconfirmed / finished dispatch is NOT confirmed stopped
  for (const stopState of ["stopping", "unconfirmed", "finished"] as const) {
    assert.equal(
      isConfirmedStoppedTurn(
        [
          msg("u-disp", { state: "assigned", ticketId: "t1" }),
          msg("d-1", { role: "assistant", kind: "dispatch", sourceMessageId: "u-disp", ticketId: "t1", stopState }),
        ],
        [t1],
        "u-disp",
      ),
      false,
    )
  }

  // 5) Worker turn cancelled (even if stop occurred inside worker session without dispatch.stopState)
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-w", { state: "assigned", ticketId: "t1" }),
        msg("d-w", { role: "assistant", kind: "dispatch", sourceMessageId: "u-w", ticketId: "t1" }),
        msg("w-res", { role: "worker", workerEvent: "result", sourceMessageId: "u-w", ticketId: "t1", stopState: "stopped", text: "partial" }),
      ],
      [t1],
      "u-w",
    ),
    true,
  )

  // 6) Split request: 1 branch stopped + 1 branch still running or completed -> NOT confirmed stopped
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-split", { state: "assigned" }),
        msg("d-a", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t1", stopState: "stopped" }),
        msg("d-b", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t2" }),
      ],
      [t1, t2],
      "u-split",
    ),
    false,
  )
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-split", { state: "assigned" }),
        msg("d-a", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t1", stopState: "stopped" }),
        msg("d-b", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t2" }),
        msg("w-b", { role: "worker", workerEvent: "result", sourceMessageId: "u-split", ticketId: "t2", text: "done" }),
      ],
      [t1, t2],
      "u-split",
    ),
    false,
  )
  // Both branches stopped -> confirmed stopped
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-split", { state: "assigned" }),
        msg("d-a", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t1", stopState: "stopped" }),
        msg("d-b", { role: "assistant", kind: "dispatch", sourceMessageId: "u-split", ticketId: "t2", stopState: "stopped" }),
      ],
      [t1, t2],
      "u-split",
    ),
    true,
  )

  // 7) Unattributed worker stopped result never marks an adjacent user message as stopped
  assert.equal(
    isConfirmedStoppedTurn(
      [
        msg("u-adj", { state: "assigned", ticketId: "t1" }),
        msg("w-orphan", { role: "worker", workerEvent: "result", ticketId: "t1", stopState: "stopped" }),
      ],
      [t1],
      "u-adj",
    ),
    false,
  )
})

test("resolveSupersededStoppedTurns uses only explicit reEditOf on confirmed stopped turns", () => {
  const messages: SuperMessage[] = [
    msg("u-1", { text: "在 Super Agent 的设置项中，增加啊啊啊给 Super Agent 改名", state: "stopped" }),
    // Adjacent manually sent message with nearly identical text, NO reEditOf
    msg("u-manual", { text: "在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。", state: "answered" }),
    msg("u-active", { text: "还在路由", state: "routing" }),
    // Invalid reEditOf pointing to non-stopped or self must be ignored
    msg("u-bad-ref", { text: "误指", state: "answered", reEditOf: "u-active" }),
    msg("u-self", { text: "自指", state: "stopped", reEditOf: "u-self" }),
  ]

  assert.equal(resolveSupersededStoppedTurns(messages, []).size, 0)

  const withExplicit = [
    ...messages,
    msg("u-revised", { text: "修正后的明确版本", state: "routing", reEditOf: "u-1" }),
  ]
  const resolved = resolveSupersededStoppedTurns(withExplicit, [])
  assert.deepEqual([...resolved.entries()], [["u-1", "u-revised"]])
})

test("parseSuperReusedAttachments validates structure and bounds", () => {
  assert.equal(parseSuperReusedAttachments(undefined), undefined)
  assert.deepEqual(parseSuperReusedAttachments([]), [])
  assert.deepEqual(
    parseSuperReusedAttachments([{ messageId: "m1", index: 0 }, { messageId: "m1", index: 2 }]),
    [{ messageId: "m1", index: 0 }, { messageId: "m1", index: 2 }],
  )
  assert.throws(() => parseSuperReusedAttachments("bad"))
  assert.throws(() => parseSuperReusedAttachments([{ messageId: "", index: 0 }]))
  assert.throws(() => parseSuperReusedAttachments([{ messageId: "m1", index: -1 }]))
  assert.throws(() => parseSuperReusedAttachments([{ messageId: "m1", index: 1.5 }]))
  assert.throws(() => parseSuperReusedAttachments([{ messageId: "m1", index: 100 }]))
})
