import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { DaemonCatalog } from "./catalog.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"

class SystemPromptProvider implements AgentProvider {
  id = "codex"
  opened: acp.NewSessionRequest[] = []
  resumed: acp.ResumeSessionRequest[] = []
  forked: acp.ForkSessionRequest[] = []
  #nextFork = 1

  async connect(_config: AgentConfig): Promise<AgentConnection> {
    return {
      initialization: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: {
            resume: {},
            fork: {},
            systemPrompt: {},
          },
        },
      },
      newSession: async params => {
        this.opened.push(params)
        return { sessionId: "provider-session-1" }
      },
      resume: async params => {
        this.resumed.push(params)
        return {}
      },
      forkSession: async params => {
        this.forked.push(params)
        return { sessionId: `provider-fork-${this.#nextFork++}` }
      },
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async () => ({ stopReason: "end_turn" }),
      steer: async () => ({ outcome: "inactive" }),
      cancel: async () => {},
      close: async () => {},
    }
  }
}

async function setup(t: TestContext, provider: SystemPromptProvider) {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-prompt-"))
  const workDir = join(directory, "work")
  const daemonDirectory = join(directory, "daemon")
  await mkdir(workDir)
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const service = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
  })
  return { service, workDir, actor: service.actor() }
}

test("Super Agent coordinator systemPrompt is sent on newSession, resume, and forkSession", async t => {
  const provider = new SystemPromptProvider()
  const { service, workDir, actor } = await setup(t, provider)

  const created = await service.handle("_deskfleet/session/create", {
    operationId: randomUUID(),
    provider: "codex",
    context: "directory",
    cwd: workDir,
    superAgent: true,
  }, actor) as AgentSnapshot
  assert.equal(created.session.superAgent, true)
  assert.equal(provider.opened.length, 1)
  assert.equal(provider.opened[0]?.systemPrompt?.mode, "append")
  assert.match(provider.opened[0]?.systemPrompt?.content[0]?.type === "text" ? provider.opened[0].systemPrompt.content[0].text : "", /Super Agent coordinator/)

  await service.handle("_deskfleet/session/stop", { sessionId: created.session.id, operationId: randomUUID() }, actor)
  await service.handle("_deskfleet/session/resume", { sessionId: created.session.id, operationId: randomUUID() }, actor)
  assert.equal(provider.resumed.length, 1)
  assert.deepEqual(provider.resumed[0]?.systemPrompt, provider.opened[0]?.systemPrompt)

  const forked = await service.handle("_deskfleet/session/fork", {
    sessionId: created.session.id,
    context: "directory",
    operationId: randomUUID(),
  }, actor) as AgentSnapshot
  assert.equal(forked.session.superAgent, true)
  assert.equal(provider.forked.length, 1)
  assert.deepEqual(provider.forked[0]?.systemPrompt, provider.opened[0]?.systemPrompt)
})
