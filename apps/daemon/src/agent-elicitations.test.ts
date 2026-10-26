import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import { AgentElicitations } from "./agent-elicitations.ts"
import type { AgentCommand, AgentElicitation } from "./agent-protocol.ts"
import { AgentJournal, timestamp } from "./agent-store.ts"

const urlRequest: acp.CreateElicitationRequest = {
  mode: "url", sessionId: "provider", elicitationId: "browser-flow", message: "Finish the browser flow", url: "https://example.invalid/continue",
}

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const native = await openInMemoryCatalog("URL questions")
  t.after(() => native.close())
  const workspace = await native.createWorkspace("Workspace", [{ path: process.cwd() }])
  const journal = new AgentJournal(native)
  await journal.init()
  const creation: AgentCommand = {
    id: await journal.id(), operationId: randomUUID(), actor: journal.actor(), method: "_deskfleet/session/create",
    params: {}, isCanonical: true, status: "accepted", receivedAt: timestamp(),
  }
  const created = await journal.create(creation, workspace.id, "URL question", "directory", "fixture")
  const state = { running: true, connected: true, generation: 1 }
  const snapshot = await journal.read(created.id)
  const session = { ...snapshot.session, lifecycle: "ready" as const, providerSessionId: "provider" }
  const run = { sessionId: session.id, generation: 1, state: "running" as const, startedAt: timestamp() }
  await journal.commit(snapshot, { session, runs: [run], events: [journal.event(session.id, "session", session), journal.event(session.id, "run", run)] })
  const elicitations = new AgentElicitations(journal, session.id, () => state)
  const read = async () => (await journal.read(session.id)).elicitations
  function begin(request = urlRequest) {
    let release!: () => void
    const saved = new Promise<AgentElicitation>(resolve => {
      release = journal.onEvent(event => { if (event.kind === "elicitation" && (event.payload as AgentElicitation).state === "pending") { release(); resolve(event.payload as AgentElicitation) } })
    })
    const answer = elicitations.request(request, new AbortController().signal, state.generation)
    return { saved, answer }
  }
  async function respond(row: AgentElicitation, action: "accept" | "decline" | "cancel" = "accept") {
    const command: AgentCommand = { ...creation, id: await journal.id(), sessionId: session.id, operationId: randomUUID(),
      method: "_deskfleet/elicitation/respond", params: { elicitationId: row.id, response: { action } } }
    return elicitations.respond(command, { action })
  }
  return { journal, elicitations, state, read, begin, respond, session }
}

test("URL acceptance and provider completion are separately durable and duplicate completions are ignored", async t => {
  const f = await setup(t)
  const pending = f.begin()
  const row = await pending.saved
  const accepted = await f.respond(row)
  assert.deepEqual(await pending.answer, { action: "accept" })
  assert.equal(accepted.state, "resolved")
  assert.equal(accepted.completedAt, undefined)
  await f.elicitations.complete({ elicitationId: "unknown" }, 1)
  assert.equal((await f.read())[0]!.completedAt, undefined)
  await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
  const completed = (await f.read())[0]!
  assert.ok(completed.completedAt)
  assert.deepEqual(completed.response, { action: "accept" })
  const seq = (await f.journal.read(f.session.id)).session.lastEventSeq
  await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
  assert.equal((await f.journal.read(f.session.id)).session.lastEventSeq, seq)
  assert.deepEqual((await f.read())[0], completed)
})

test("completion arriving during creation or before consent is retained when consent commits", async t => {
  for (const beforeSave of [true, false]) {
    const f = await setup(t)
    const pending = f.begin()
    if (beforeSave) await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
    const row = await pending.saved
    if (!beforeSave) await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
    assert.equal((await f.read())[0]!.state, "pending")
    const accepted = await f.respond(row)
    assert.deepEqual(await pending.answer, { action: "accept" })
    assert.ok(accepted.completedAt)
    assert.ok((await f.read())[0]!.completedAt)
  }
})

test("declining or cancelling before consent removes an early URL completion", async t => {
  for (const outcome of ["decline", "cancel", "stop"] as const) {
    const f = await setup(t)
    const pending = f.begin()
    const row = await pending.saved
    await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
    assert.ok((await f.read())[0]!.completedAt)
    if (outcome === "stop") await f.elicitations.cancel()
    else await f.respond(row, outcome)
    assert.deepEqual(await pending.answer, { action: outcome === "decline" ? "decline" : "cancel" })
    const cancelled = (await f.read())[0]!
    assert.equal(Object.hasOwn(cancelled, "completedAt"), false)
    assert.notEqual(cancelled.state, "pending")
  }
})

test("accepted URL completion remains valid while the connected runtime is finishing a turn", async t => {
  const f = await setup(t)
  const pending = f.begin()
  await f.respond(await pending.saved)
  await pending.answer
  f.state.running = false
  assert.deepEqual(await f.elicitations.request({ ...urlRequest, elicitationId: "new-flow" }, new AbortController().signal, 1), { action: "cancel" })
  await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
  assert.ok((await f.read())[0]!.completedAt)
})

test("declined flows, stale connections, and provider shutdown never become completed", async t => {
  for (const outcome of ["decline", "stale", "disconnect", "stop"] as const) {
    const f = await setup(t)
    const pending = f.begin()
    const row = await pending.saved
    await f.respond(row, outcome === "decline" ? "decline" : "accept")
    await pending.answer
    if (outcome === "stale") f.state.generation = 2
    if (outcome === "disconnect") f.state.connected = false
    if (outcome === "stop") { f.state.running = false; f.state.connected = false; await f.elicitations.cancel() }
    await f.elicitations.complete({ elicitationId: "browser-flow" }, 1)
    assert.equal((await f.read())[0]!.completedAt, undefined)
  }
})

test("unsupported schemes and request-scoped URLs are cancelled without storing a question", async t => {
  const f = await setup(t)
  for (const request of [
    { ...urlRequest, url: "file:///tmp/private" },
    { mode: "url", requestId: 1, elicitationId: "auth", message: "Sign in", url: "https://example.invalid/" } as acp.CreateElicitationRequest,
    { ...urlRequest, sessionId: "another-provider-session" },
  ]) {
    assert.deepEqual(await f.elicitations.request(request, new AbortController().signal, 1), { action: "cancel" })
  }
  assert.deepEqual(await f.read(), [])
})
