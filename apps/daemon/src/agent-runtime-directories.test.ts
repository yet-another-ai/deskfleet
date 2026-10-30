import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentConnection, AgentProvider } from "./agents/acp.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { DaemonCatalog } from "./catalog.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"

class DirectoryProvider implements AgentProvider {
  id = "codex"
  additionalDirectories = false
  opened: acp.NewSessionRequest[] = []
  resumed: acp.ResumeSessionRequest[] = []
  prompts: acp.PromptRequest[] = []

  async connect(): Promise<AgentConnection> {
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {
        resume: {}, ...(this.additionalDirectories ? { additionalDirectories: {} } : {}),
      } } },
      newSession: async params => { this.opened.push(params); return { sessionId: "conversation" } },
      resume: async params => { this.resumed.push(params); return {} },
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async params => { this.prompts.push(params); return { stopReason: "end_turn" } },
      steer: async () => ({ outcome: "inactive" }),
      cancel: async () => {},
      close: async () => {},
    }
  }
}

async function setup(t: TestContext, provider: DirectoryProvider) {
  const directory = await mkdtemp(join(tmpdir(), "df-runtime-directories-"))
  const directories = [join(directory, "primary"), join(directory, "additional")]
  for (const path of directories) await mkdir(path)
  const daemonDirectory = join(directory, "daemon")
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Multiple directories", directories.map(path => ({ path })))
  const service = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
  })
  const actor = service.actor()
  const created = await service.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory",
  }, actor) as AgentSnapshot
  const sessionId = created.session.id
  const read = () => service.journal.read(sessionId)
  const stop = () => service.handle("_deskfleet/session/stop", { sessionId, operationId: randomUUID() }, actor)
  const resume = () => service.handle("_deskfleet/session/resume", { sessionId, operationId: randomUUID() }, actor)
  const submit = () => service.handle("_deskfleet/input/submit", {
    sessionId, operationId: randomUUID(), content: [{ type: "text", text: "Continue the task" }], delivery: "backlog",
  }, actor)
  return { created, directories, read, stop, resume, submit }
}

async function completedTurns(read: () => Promise<AgentSnapshot>, count: number): Promise<AgentSnapshot> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await read()
    if (snapshot.turns.length === count && snapshot.turns.every(turn => turn.state === "completed")) return snapshot
    await delay(10)
  }
  throw new Error("Timed out waiting for completed turns")
}

for (const supported of [false, true]) {
  test(`multi-directory Sessions start, execute, and resume when additional directories are ${supported ? "supported" : "unsupported"}`, async t => {
    const provider = new DirectoryProvider()
    provider.additionalDirectories = supported
    const f = await setup(t, provider)
    assert.equal(f.created.session.error, undefined)
    assert.equal(f.created.session.capabilities?.additionalDirectories, supported)
    assert.equal(f.created.runs[0]?.state, "running")
    const expected = { cwd: f.directories[0], mcpServers: [], ...(supported ? { additionalDirectories: f.directories.slice(1) } : {}) }
    assert.deepEqual(provider.opened, [expected])

    await f.submit()
    const first = await completedTurns(f.read, 1)
    assert.equal(first.session.error, undefined)
    assert.equal(first.inputs[0]?.state, "delivered")
    await f.stop()
    await f.resume()
    assert.deepEqual(provider.resumed, [{ ...expected, sessionId: "conversation" }])

    await f.submit()
    const resumed = await completedTurns(f.read, 2)
    assert.equal(resumed.session.error, undefined)
    assert.equal(resumed.session.capabilities?.additionalDirectories, supported)
    assert.equal(resumed.runs.at(-1)?.state, "running")
    assert.equal(provider.prompts.length, 2)
  })
}

test("resuming refreshes additional-directory support after a provider changes", async t => {
  const provider = new DirectoryProvider()
  const f = await setup(t, provider)
  assert.equal(f.created.session.capabilities?.additionalDirectories, false)
  await f.stop()
  provider.additionalDirectories = true
  await f.resume()
  const resumed = await f.read()
  assert.equal(resumed.session.capabilities?.additionalDirectories, true)
  assert.deepEqual(provider.resumed[0]?.additionalDirectories, f.directories.slice(1))
})
