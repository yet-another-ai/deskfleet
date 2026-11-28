import assert from "node:assert/strict"
import { test } from "node:test"
import {
  dedupeTicketIds,
  messageMatchesTicketFocus,
  parseSuperCreateTicket,
  parseSuperLinkMessage,
  resolveCanonicalMessageTicketIds,
} from "./super-agent-links.ts"

test("resolveCanonicalMessageTicketIds gives snapshotLinks authoritative precedence (including empty unlink overrides)", () => {
  const known = new Set(["ticket-a", "ticket-b"])

  // Explicit empty array overrides legacy ticketId so unlinked messages never remain colored or in focus.
  const unlinked = resolveCanonicalMessageTicketIds({
    message: { id: "m1", role: "user", ticketId: "ticket-a", ticketIds: ["ticket-a"] },
    snapshotLinks: { m1: [] },
    knownTicketIds: known,
  })
  assert.deepEqual(unlinked, [])
  assert.equal(messageMatchesTicketFocus(unlinked, "ticket-a"), false)

  // Explicit multi-ticket snapshotLinks deduplicate and filter unknown tickets.
  const multi = resolveCanonicalMessageTicketIds({
    message: { id: "m2", role: "assistant", sourceMessageId: "m1" },
    snapshotLinks: { m2: ["ticket-a", "ticket-b", "ticket-a", "missing"] },
    knownTicketIds: known,
  })
  assert.deepEqual(multi, ["ticket-a", "ticket-b"])
  assert.equal(messageMatchesTicketFocus(multi, "ticket-a"), true)
  assert.equal(messageMatchesTicketFocus(multi, "ticket-b"), true)
  assert.equal(messageMatchesTicketFocus(multi, "ticket-c"), false)
  assert.equal(messageMatchesTicketFocus(multi, undefined), true)
})

test("resolveCanonicalMessageTicketIds falls back cleanly for legacy snapshots without messageTicketLinks", () => {
  const known = new Set(["ticket-a", "ticket-b"])

  // Legacy split dispatch user message
  assert.deepEqual(
    resolveCanonicalMessageTicketIds({
      message: { id: "split-u", role: "user" },
      dispatchTicketIds: ["ticket-a", "ticket-b"],
      knownTicketIds: known,
    }),
    ["ticket-a", "ticket-b"],
  )

  // Legacy assistant reply inherits from sourceMessage
  assert.deepEqual(
    resolveCanonicalMessageTicketIds({
      message: { id: "reply-1", role: "assistant", sourceMessageId: "ask-1" },
      sourceMessage: { id: "ask-1", role: "user", ticketId: "ticket-a" },
      knownTicketIds: known,
    }),
    ["ticket-a"],
  )

  // Message-level ticketIds used when snapshotLinks absent
  assert.deepEqual(
    resolveCanonicalMessageTicketIds({
      message: { id: "disc-1", role: "user", ticketIds: ["ticket-a", "ticket-b"] },
      knownTicketIds: known,
    }),
    ["ticket-a", "ticket-b"],
  )
})

test("dedupeTicketIds, parseSuperLinkMessage, and parseSuperCreateTicket validate and normalize inputs", () => {
  assert.deepEqual(dedupeTicketIds(["a", undefined, "b", "a", ""]), ["a", "b"])

  assert.deepEqual(
    parseSuperLinkMessage({ workspaceId: "ws-1", messageId: "m-1", ticketIds: ["t-1", "t-2", "t-1"] }),
    { workspaceId: "ws-1", messageId: "m-1", ticketIds: ["t-1", "t-2"] },
  )
  assert.deepEqual(
    parseSuperLinkMessage({ workspaceId: null, messageId: "m-1", ticketIds: [] }),
    { workspaceId: null, messageId: "m-1", ticketIds: [] },
  )
  assert.throws(() => parseSuperLinkMessage({ workspaceId: "ws-1", messageId: "m-1", ticketIds: "t-1" }), /Invalid ticket ID list/)

  assert.deepEqual(
    parseSuperCreateTicket({ workspaceId: "ws-1", messageId: "m-1", title: "  跟进配色优化  ", scope: "  只改标签  " }),
    { workspaceId: "ws-1", messageId: "m-1", title: "跟进配色优化", scope: "只改标签" },
  )
  assert.throws(() => parseSuperCreateTicket({ workspaceId: "ws-1", messageId: "m-1", title: "   " }), /ticket title/i)
})
