import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import { AgentJournal, timestamp } from "./agent-store.ts"
import { compactCommandResult } from "./agent-command-results.ts"
import type { AgentCommand, AgentEvent, AgentInput } from "./agent-protocol.ts"

test("snapshot command receipts and their events stay bounded as conversation inputs grow", async t => {
  const native = await openInMemoryCatalog("compact-command-results")
  t.after(() => native.close())
  const journal = new AgentJournal(native)
  await journal.init()
  const create: AgentCommand = {
    id: await journal.id(), operationId: randomUUID(), actor: journal.actor(),
    method: "_deskfleet/session/create", params: {}, isCanonical: true,
    status: "accepted", receivedAt: timestamp(),
  }
  const session = await journal.create(create, undefined, "Receipts", "directory", "codex")
  const snapshot = await journal.read(session.id)
  const input: AgentInput = {
    id: await journal.id(), sessionId: session.id, submissionCommandId: create.id,
    author: journal.actor(), content: [{ type: "text", text: "retained input ".repeat(10_000) }],
    acceptedSeq: "1", state: "delivered", requestedDelivery: "backlog", createdAt: timestamp(),
  }
  const reference = { kind: "session_snapshot", sessionId: session.id }
  for (let index = 0; index < 5; index++) {
    snapshot.inputs.push({ ...input, id: String(index + 1) })
    const command: AgentCommand = { ...create, id: await journal.id(), operationId: randomUUID(),
      sessionId: session.id, method: "_deskfleet/session/read", status: "completed", result: snapshot }
    await journal.saveCommand(command)
    const persisted = await native.agentCommand(command.operationId)
    assert.deepEqual(JSON.parse(persisted).result, reference)
    assert.ok(persisted.length < 1_000, "The receipt must not grow with previous inputs")
    assert.equal(command.result, snapshot, "The immediate operation response is untouched")
  }
  const events = JSON.parse(await native.agentHistory(session.id, "0", 200)) as AgentEvent[]
  assert.equal(events.filter(event => event.kind === "command").length, 5)
  assert.ok(events.filter(event => event.kind === "command").every(event =>
    JSON.stringify((event.payload as AgentCommand).result) === JSON.stringify(reference)))
  assert.ok((await journal.commandsSince(session.id, "-1")).commands.every(command =>
    command.status !== "completed" || JSON.stringify(command.result) === JSON.stringify(reference)))
})

test("previously stored snapshot results are compacted for replay and sync, while other result contracts remain intact", async t => {
  const native = await openInMemoryCatalog("existing-command-results")
  t.after(() => native.close())
  const journal = new AgentJournal(native)
  await journal.init()
  const command: AgentCommand = {
    id: await journal.id(), operationId: randomUUID(), actor: journal.actor(),
    method: "_deskfleet/session/create", params: {}, isCanonical: true,
    status: "accepted", receivedAt: timestamp(),
  }
  const session = await journal.create(command, undefined, "Existing", "directory", "codex")
  const result = await journal.read(session.id)
  const completed = { ...command, sessionId: session.id, status: "completed" as const, result }
  await native.agentCommit(JSON.stringify({ sessionId: session.id, expectedSeq: session.lastEventSeq,
    command: completed, events: [journal.event(session.id, "command", completed)] }))
  const reference = { kind: "session_snapshot", sessionId: session.id }
  assert.deepEqual((await journal.command(command.operationId))!.result, reference)
  assert.deepEqual((await journal.commands(session.id))[0]!.result, reference)
  assert.deepEqual((await journal.commandsSince(session.id, "-1")).commands[0]!.result, reference)
  assert.deepEqual(((await journal.history(session.id, "0"))[0]!.payload as AgentCommand).result, reference)
  for (const method of ["_deskfleet/session/configure", "_deskfleet/input/submit", "_deskfleet/permission/respond"]) {
    const other = { ...completed, method }
    assert.equal(compactCommandResult(other), other, "Only snapshot-returning methods may change their stored outcome")
  }
})
