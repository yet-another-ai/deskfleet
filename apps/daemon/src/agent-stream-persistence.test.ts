import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test, { type TestContext } from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import { AgentJournal, timestamp, type AgentPersistence } from "./agent-store.ts"
import type { AgentEvent, AgentPreview } from "./agent-protocol.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { AgentProviders } from "./agent-providers.ts"
import { CentralSync } from "./central-sync.ts"

async function fixture(t: TestContext) {
  const native = await openInMemoryCatalog("streaming")
  t.after(() => native.close())
  const workspace = await native.createWorkspace("Streaming", [{ path: process.cwd() }])
  let failWrite = false
  let writes = 0
  const persistence = new Proxy(native, {
    get(target, property) {
      if (property === "agentCommit") return async (value: string) => {
        writes++
        if (failWrite) { failWrite = false; throw new Error("disk unavailable") }
        return native.agentCommit(value)
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as AgentPersistence
  const journal = new AgentJournal(persistence)
  await journal.init()
  const session = await journal.create({
    id: await journal.id(), operationId: randomUUID(), actor: journal.actor(),
    workspaceId: workspace.id, method: "_deskfleet/session/create", params: {},
    isCanonical: true, status: "accepted", receivedAt: timestamp(),
  }, workspace.id, "Streaming", "directory", "codex")
  const events: AgentEvent[] = [], previews: AgentPreview[] = [], failures: unknown[] = []
  journal.onEvent(event => events.push(event))
  journal.onPreview(preview => previews.push(preview))
  const stream = (text: string) => journal.stream(journal.event(session.id, "acp", {
    sessionId: "provider", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  }), error => failures.push(error))
  return { native, journal, session, events, previews, failures, stream, writes: () => writes, failWrite: () => { failWrite = true } }
}

test("text previews are immediate and continuous output commits at five seconds from the first chunk", async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.stream("first")
  assert.equal(f.writes(), 0)
  assert.equal(f.previews.length, 1)
  assert.equal(f.previews[0]!.offset, 0)
  assert.equal(f.previews[0]!.baseSeq, f.session.lastEventSeq)
  assert.equal(f.events.length, 0)
  assert.deepEqual(await f.journal.history(f.session.id, f.session.lastEventSeq), [])
  for (let second = 1; second < 5; second++) {
    t.mock.timers.tick(1_000)
    await f.stream(String(second))
    assert.equal(f.writes(), 0)
  }
  t.mock.timers.tick(1_000)
  await f.journal.serial(f.session.id, async () => {}, { flushStreaming: false })
  assert.equal(f.writes(), 1)
  assert.equal(f.events.length, 5)
  assert.deepEqual(f.events.map(event => event.seq), [1, 2, 3, 4, 5].map(offset => String(BigInt(f.session.lastEventSeq) + BigInt(offset))))
  assert.equal(f.journal.preview(f.session.id), undefined)
  const previous = f.previews[0]!.streamId
  await f.stream("next window")
  assert.notEqual(f.previews.at(-1)!.streamId, previous)
  assert.equal(f.previews.at(-1)!.baseSeq, f.events.at(-1)!.seq)
  await f.journal.serial(f.session.id, async () => {})
})

test("domain operations flush preceding text before reading their durable sequence", async t => {
  const f = await fixture(t)
  await f.stream("before tool")
  const replay = f.journal.preview(f.session.id)!
  await f.stream("second")
  assert.equal(replay.events.length, 1, "Subscription replay is a stable copy")
  await f.journal.serial(f.session.id, async () => {
    const current = await f.journal.session(f.session.id)
    assert.equal(current.lastEventSeq, String(BigInt(f.session.lastEventSeq) + 2n))
    await f.journal.commit(current, { events: [f.journal.event(f.session.id, "acp", {
      sessionId: "provider", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", status: "pending" },
    })] })
  })
  assert.equal(f.writes(), 2)
  assert.deepEqual(f.events.map(event => "update" in event.payload && event.payload.update.sessionUpdate), ["agent_thought_chunk", "agent_thought_chunk", "tool_call"])
  assert.deepEqual(await f.journal.history(f.session.id, f.session.lastEventSeq), f.events)
})

test("central synchronization observes only durable history and does not shorten the text window", async t => {
  const f = await fixture(t)
  await f.stream("not yet persisted")
  const uploads: { events: AgentEvent[] }[] = []
  const sync = new CentralSync({ journal: f.journal, onEvent: f.journal.onEvent.bind(f.journal) } as AgentSessions,
    { snapshot: async () => ({}), onChange: () => () => {} } as unknown as DaemonCatalog,
    { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders,
    async (path, value) => {
      if (!path.endsWith("history")) return {}
      const upload = value as { events: AgentEvent[]; snapshot?: { session: { lastEventSeq: string } } }
      uploads.push(upload)
      return { lastEventSeq: upload.events.at(-1)?.seq ?? upload.snapshot!.session.lastEventSeq }
    }, async () => false)
  t.after(() => sync.close())
  sync.enable()
  await sync.flush()
  assert.equal(f.writes(), 0)
  assert.ok(uploads.every(upload => upload.events.every(event => event.kind !== "acp")))
  await f.journal.serial(f.session.id, async () => {})
  await sync.flush()
  assert.ok(uploads.at(-1)!.events.some(event => event.kind === "acp"))
})

test("failed timed persistence retains the preview without publishing durable events", async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  await f.stream("retry me")
  f.failWrite()
  t.mock.timers.tick(5_000)
  await f.journal.serial(f.session.id, async () => {}, { flushStreaming: false })
  assert.equal(f.failures.length, 1)
  assert.equal(f.events.length, 0)
  assert.equal(f.journal.preview(f.session.id)?.events.length, 1)
  assert.deepEqual(await f.journal.history(f.session.id, f.session.lastEventSeq), [])
  await f.journal.serial(f.session.id, async () => {})
  assert.equal(f.events.length, 1)
  assert.equal(f.journal.preview(f.session.id), undefined)
})
