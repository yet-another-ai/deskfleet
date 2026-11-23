import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import { wrapAntigravityConnection } from "@deskfleet/agent-antigravity"
import type { AgentConfig, AgentConnection, AgentProvider } from "../acp/connection.ts"
import { AgentMcp } from "./mcp.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { AgentSessions } from "./sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"

class SystemPromptProvider implements AgentProvider {
  id = "codex"
  opened: acp.NewSessionRequest[] = []
  resumed: acp.ResumeSessionRequest[] = []
  forked: acp.ForkSessionRequest[] = []
  #nextFork = 1
  readonly #antigravityMeta: boolean

  constructor(antigravityMeta = false) {
    this.#antigravityMeta = antigravityMeta
  }

  async connect(_config: AgentConfig): Promise<AgentConnection> {
    const raw: AgentConnection = {
      initialization: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: {
            resume: {},
            fork: {},
            ...(this.#antigravityMeta ? {} : { systemPrompt: {} }),
          },
          ...(this.#antigravityMeta ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {}),
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
    return this.#antigravityMeta ? wrapAntigravityConnection(raw) : raw
  }
}

async function setup(t: TestContext, provider: SystemPromptProvider, withMcp = false) {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-prompt-"))
  const workDir = join(directory, "work")
  const daemonDirectory = join(directory, "daemon")
  await mkdir(workDir)
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const mcp = withMcp ? new AgentMcp({ async authorize() {}, async dispatch() { return null } }) : undefined
  await mcp?.init()
  const service = new AgentSessions(catalog, catalog.native, provider, undefined, mcp, undefined, new TestAgentQuotas())
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await mcp?.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) }
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

test("ordinary Sessions with built-in DeskFleet MCP receive delegation guidance, including Antigravity _meta append", async t => {
  const userActor: AgentActor = { kind: "user", userId: "u1", deviceId: "login1" }

  const standard = new SystemPromptProvider(false)
  const { service: stdService, workDir: stdDir, actor: localActor } = await setup(t, standard, true)

  // Local non-user session has no built-in deskfleet MCP server, so no MCP delegation prompt is sent.
  await stdService.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider: "codex", context: "directory", cwd: stdDir,
  }, localActor)
  assert.equal(standard.opened[0]?.systemPrompt, undefined)

  // Authenticated user session receives DeskFleet MCP delegation guidance on newSession, resume, and forkSession.
  const delegated = await stdService.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider: "codex", context: "directory", cwd: stdDir,
  }, userActor) as AgentSnapshot
  const promptText = standard.opened[1]?.systemPrompt?.content[0]?.type === "text" ? standard.opened[1].systemPrompt.content[0].text : ""
  assert.equal(standard.opened[1]?.systemPrompt?.mode, "append")
  assert.match(promptText, /deskfleet_session_create/)

  const antigravity = new SystemPromptProvider(true)
  const { service: agyService, workDir: agyDir } = await setup(t, antigravity, true)
  const agySession = await agyService.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider: "codex", context: "directory", cwd: agyDir,
  }, userActor) as AgentSnapshot
  assert.equal(antigravity.opened[0]?.systemPrompt, undefined)
  const openedAppend = (antigravity.opened[0]?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append ?? ""
  assert.match(openedAppend, /deskfleet_session_create/)

  await agyService.handle("_deskfleet/session/stop", { sessionId: agySession.session.id, operationId: randomUUID() }, userActor)
  await agyService.handle("_deskfleet/session/resume", { sessionId: agySession.session.id, operationId: randomUUID() }, userActor)
  assert.equal(antigravity.resumed[0]?.systemPrompt, undefined)
  assert.deepEqual(antigravity.resumed[0]?._meta, antigravity.opened[0]?._meta)

  await agyService.handle("_deskfleet/session/fork", { sessionId: agySession.session.id, context: "directory", operationId: randomUUID() }, userActor)
  assert.equal(antigravity.forked[0]?.systemPrompt, undefined)
  assert.deepEqual(antigravity.forked[0]?._meta, antigravity.opened[0]?._meta)
  assert.ok(delegated.session.id)
})
