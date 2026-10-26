import assert from "node:assert/strict"
import test from "node:test"
import type { AgentSessions } from "./agent-sessions.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { CentralSync } from "./central-sync.ts"

test("catalog publication reports runtime desktop support and updates after authorization changes", async t => {
  let desktop = false
  const agents = { onEvent: () => () => {}, journal: { list: async () => [] } } as unknown as AgentSessions
  const catalog = { native: { snapshot: async () => ({}) }, onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const published: boolean[] = []
  const sync = new CentralSync(agents, catalog, providers, async (_path, body) => {
    published.push((body as { capabilities: { desktop: boolean } }).capabilities.desktop)
  }, async () => desktop)
  t.after(() => sync.close())
  sync.enable()
  await sync.flush()
  desktop = true
  sync.changed()
  await sync.flush()
  assert.deepEqual(published, [false, true])
})

test("history retries replay durable events while snapshot and audit may lead the contiguous ACK", async context => {
  let lastEventSeq = "251", acknowledged = 0, failNext = true
  const snapshot = () => ({ session: { id: "session", lastEventSeq } })
  const agents = {
    onEvent: () => () => {},
    journal: {
      list: async () => [snapshot().session], read: async () => snapshot(),
      commands: async () => [{ operationId: "command", status: "completed" }],
      serial: async (_id: string, action: () => Promise<unknown>) => action(),
      history: async (_id: string, after: string, limit: number) => Array.from({ length: Math.min(limit, Number(lastEventSeq) - Number(after)) }, (_, offset) => ({ sessionId: "session", seq: String(Number(after) + offset + 1) })),
    },
  } as unknown as AgentSessions
  const catalog = { native: { snapshot: async () => ({ workspaces: [] }) }, onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({ providers: [{ id: "codex", name: "Codex", template: "codex" }] }), onChanged: () => () => {} } as unknown as AgentProviders
  const batches: number[][] = []
  const post = async (path: string, body: unknown) => {
    if (path.endsWith("catalog")) return {}
    const value = body as { snapshot: ReturnType<typeof snapshot>; events: { seq: string }[]; commands: unknown[] }
    assert.equal(value.snapshot.session.lastEventSeq, lastEventSeq)
    assert.equal(value.commands.length, 1)
    batches.push(value.events.map(event => Number(event.seq)))
    for (const event of value.events) {
      const seq = Number(event.seq)
      if (seq > acknowledged) { assert.equal(seq, acknowledged + 1); acknowledged = seq }
    }
    // Simulate commit succeeding but its HTTP response being lost.
    if (failNext) { failNext = false; throw new Error("response lost") }
    return { lastEventSeq: String(acknowledged) }
  }
  const sync = new CentralSync(agents, catalog, providers, post, async () => false)
  context.after(() => sync.close())
  sync.enable()
  await assert.rejects(sync.flush(), /response lost/)
  assert.equal(acknowledged, 200)
  await sync.flush()
  assert.equal(acknowledged, 251)
  assert.deepEqual(batches.map(batch => [batch[0], batch.at(-1)]), [[1, 200], [1, 200], [201, 251]])
  lastEventSeq = "252"
  sync.changed("session")
  await sync.flush()
  assert.deepEqual(batches.at(-1), [252])
  const count = batches.length
  sync.changed()
  await sync.flush()
  assert.equal(batches.length, count, "Catalog-only changes do not repeatedly upload unchanged history")
  await sync.close()
  const restarted = new CentralSync(agents, catalog, providers, post, async () => false)
  context.after(() => restarted.close())
  restarted.enable(); await restarted.flush()
  assert.equal(acknowledged, 252, "A fresh synchronization process accepts the backend's durable ACK")
})

test("shutdown flush reads final producer state even after live synchronization is disabled", async () => {
  let seq = 1
  let state = "running"
  let subscribed = true
  const snapshot = () => ({ session: { id: "session", lastEventSeq: String(seq) }, runs: [{ state }] })
  const agents = {
    onEvent: () => () => { subscribed = false },
    journal: {
      list: async () => [snapshot().session], read: async () => snapshot(),
      commands: async () => [{ status: state }], serial: async (_id: string, action: () => Promise<unknown>) => action(),
      history: async (_id: string, after: string) => Array.from({ length: seq - Number(after) }, (_, index) => ({ seq: String(Number(after) + index + 1) })),
    },
  } as unknown as AgentSessions
  const catalog = { native: { snapshot: async () => ({}) }, onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const sent: { snapshot: ReturnType<typeof snapshot>; commands: { status: string }[] }[] = []
  const sync = new CentralSync(agents, catalog, providers, async (path, body) => {
    if (path.endsWith("catalog")) return {}
    const value = body as typeof sent[number]
    sent.push(value)
    return { lastEventSeq: value.snapshot.session.lastEventSeq }
  }, async () => false)
  sync.enable(); await sync.flush()
  sync.disable()
  state = "cancelled"; seq = 2; sync.changed("session")
  await sync.close(true)
  assert.equal(subscribed, false)
  assert.deepEqual(sent.map(value => [value.snapshot.session.lastEventSeq, value.snapshot.runs[0]!.state, value.commands[0]!.status]), [
    ["1", "running", "running"], ["2", "cancelled", "cancelled"],
  ])
})
