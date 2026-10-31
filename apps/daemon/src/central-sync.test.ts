import assert from "node:assert/strict"
import test from "node:test"
import type { AgentSessions } from "./agent-sessions.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { ScheduledTask } from "./schedule-protocol.ts"
import { CentralSync } from "./central-sync.ts"

test("catalog publication reports runtime desktop support and updates after authorization changes", async t => {
  let desktop = false
  const agents = { onEvent: () => () => {}, journal: { list: async () => [] } } as unknown as AgentSessions
  const githubBranches = [{ sessionId: "1", repositories: [{ repository: "owner/repo", headRepository: "owner/repo", branch: "feature" }] }]
  const catalog = { snapshot: async () => ({ githubBranches }), onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const published: boolean[] = []
  const sync = new CentralSync(agents, catalog, providers, async (_path, body) => {
    assert.deepEqual((body as { snapshot: unknown }).snapshot, { githubBranches })
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
      commandsSince: async (_id: string, after: string) => ({ commands: after === "-1" ? [{ id: "1", operationId: "command", status: "completed" }] : [], revision: "1" }),
      serial: async (_id: string, action: () => Promise<unknown>) => action(),
      history: async (_id: string, after: string, limit: number) => Array.from({ length: Math.min(limit, Number(lastEventSeq) - Number(after)) }, (_, offset) => ({ sessionId: "session", seq: String(Number(after) + offset + 1) })),
    },
  } as unknown as AgentSessions
  const catalog = { snapshot: async () => ({ workspaces: [] }), onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({ providers: [{ id: "codex", name: "Codex", template: "codex" }] }), onChanged: () => () => {} } as unknown as AgentProviders
  const batches: number[][] = []
  const snapshots: boolean[] = [], receiptCounts: number[] = []
  const post = async (path: string, body: unknown) => {
    if (path.endsWith("catalog")) return {}
    const value = body as { snapshot?: ReturnType<typeof snapshot>; snapshotSeq?: string; events: { seq: string }[]; commands: unknown[] }
    assert.equal(value.snapshot?.session.lastEventSeq ?? value.snapshotSeq, lastEventSeq)
    snapshots.push(!!value.snapshot); receiptCounts.push(value.commands.length)
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
  assert.deepEqual(snapshots, [true, true, false])
  assert.deepEqual(receiptCounts, [1, 1, 0])
  lastEventSeq = "252"
  sync.changed("session")
  await sync.flush()
  assert.deepEqual(batches.at(-1), [252])
  assert.equal(receiptCounts.at(-1), 0, "Previously acknowledged receipts are not uploaded again")
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
      commandsSince: async () => ({ commands: [{ status: state }], revision: String(seq) }), serial: async (_id: string, action: () => Promise<unknown>) => action(),
      history: async (_id: string, after: string) => Array.from({ length: seq - Number(after) }, (_, index) => ({ seq: String(Number(after) + index + 1) })),
    },
  } as unknown as AgentSessions
  const catalog = { snapshot: async () => ({}), onChange: () => () => {} } as unknown as DaemonCatalog
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

test("receipt-only changes paginate independently and survive a lost response after the event ACK", async context => {
  let revision = "1", fail = true
  const snapshot = { session: { id: "session", lastEventSeq: "0" } }
  const cursors: string[] = []
  const agents = {
    onEvent: () => () => {},
    journal: {
      list: async () => [snapshot.session], read: async () => snapshot, history: async () => [],
      serial: async (_id: string, action: () => Promise<unknown>) => action(),
      commandsSince: async (_id: string, after: string) => {
        cursors.push(after)
        return { commands: Array.from({ length: revision === "1" ? 251 : 1 }, (_, id) => ({ id: String(id + 1), status: revision === "1" ? "accepted" : "completed" })), revision }
      },
    },
  } as unknown as AgentSessions
  const catalog = { snapshot: async () => ({}), onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const batches: { snapshot?: unknown; snapshotSeq?: string; commands: { id: string; status: string }[] }[] = []
  const sync = new CentralSync(agents, catalog, providers, async (path, body) => {
    if (path.endsWith("catalog")) return {}
    const value = body as typeof batches[number]
    batches.push(value)
    if (!value.snapshot && fail) { fail = false; throw new Error("response lost") }
    return { lastEventSeq: "0" }
  }, async () => false)
  context.after(() => sync.close())
  sync.enable()
  await assert.rejects(sync.flush(), /response lost/)
  await sync.flush()
  assert.deepEqual(batches.map(batch => batch.commands.length), [200, 51, 200, 51])
  assert.deepEqual(cursors, ["-1", "-1"], "A completed event ACK does not discard pending receipt pages")
  assert.deepEqual(batches.map(batch => !!batch.snapshot), [true, false, true, false])
  revision = "2"
  sync.changed("session")
  await sync.flush()
  assert.equal(cursors.at(-1), "1")
  assert.equal(batches.at(-1)?.commands[0]?.status, "completed")
})

function scheduleSource() {
  let tasks: ScheduledTask[] = [{
    id: "task", title: "Review changes", prompt: "Review the latest commits", workspaceId: "1", enabled: true,
    target: { kind: "new", provider: "codex", context: "directory" }, trigger: { kind: "manual" },
    createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", runs: [],
  }]
  const listeners = new Set<() => void>()
  return {
    snapshot: () => structuredClone(tasks),
    onChanged: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replace: (next: ScheduledTask[]) => { tasks = next; for (const listener of listeners) listener() },
    listeners,
  }
}

test("schedule snapshots replace the inventory on changes and reconnect, independently of chat streaming", async context => {
  const agents = { onEvent: () => () => {}, journal: { list: async () => [] } } as unknown as AgentSessions
  const catalog = { snapshot: async () => ({}), onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const schedules = scheduleSource()
  const publications: ScheduledTask[][] = []
  let catalogs = 0
  const sync = new CentralSync(agents, catalog, providers, async (path, body) => {
    if (path.endsWith("catalog")) catalogs++
    if (path.endsWith("schedules")) publications.push((body as { tasks: ScheduledTask[] }).tasks)
  }, async () => false, schedules)
  context.after(() => sync.close())
  sync.enable(); await sync.flush()
  assert.equal(publications.length, 1)
  assert.equal(publications[0]![0]!.title, "Review changes")

  for (let i = 0; i < 10; i++) { sync.changed("chat"); await sync.flush() }
  assert.equal(publications.length, 1, "Chat chunks do not republish unchanged schedules")
  const task = schedules.snapshot()[0]!
  schedules.replace([{ ...task, title: "First edit" }])
  schedules.replace([{ ...task, title: "Latest edit" }])
  await sync.flush()
  assert.equal(publications.length, 2, "Multiple edits are coalesced into the latest committed snapshot")
  assert.equal(publications[1]![0]!.title, "Latest edit")
  assert.equal(catalogs, 1, "Schedule-only changes do not republish resource catalogs")

  schedules.replace([]); await sync.flush()
  assert.deepEqual(publications.at(-1), [], "An empty inventory removes deleted tasks centrally")
  sync.disable(); sync.enable(); await sync.flush()
  assert.equal(publications.length, 4, "Reconnect republishes the authoritative inventory")
  await sync.close()
  assert.equal(schedules.listeners.size, 0)
})

test("schedule publication retries the latest state and retains changes made during an upload", async context => {
  const agents = { onEvent: () => () => {}, journal: { list: async () => [] } } as unknown as AgentSessions
  const catalog = { snapshot: async () => ({}), onChange: () => () => {} } as unknown as DaemonCatalog
  const providers = { metadata: () => ({}), onChanged: () => () => {} } as unknown as AgentProviders
  const schedules = scheduleSource()
  const publications: ScheduledTask[][] = []
  const sync = new CentralSync(agents, catalog, providers, async (path, body) => {
    if (!path.endsWith("schedules")) return
    publications.push((body as { tasks: ScheduledTask[] }).tasks)
    if (publications.length === 1) {
      schedules.replace([{ ...schedules.snapshot()[0]!, title: "Changed during failed upload" }])
      throw new Error("response lost")
    }
    if (publications.length === 2) schedules.replace([])
  }, async () => false, schedules)
  context.after(() => sync.close())
  sync.enable()
  await assert.rejects(sync.flush(), /response lost/)
  await sync.flush()
  assert.equal(publications[1]![0]!.title, "Changed during failed upload")
  await sync.flush()
  assert.deepEqual(publications[2], [], "An acknowledged older snapshot does not consume a concurrent deletion")
})
