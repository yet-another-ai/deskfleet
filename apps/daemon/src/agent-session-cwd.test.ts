import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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

class CwdProvider implements AgentProvider {
  id = "codex"
  opened: acp.NewSessionRequest[] = []
  async connect(config: AgentConfig): Promise<AgentConnection> {
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {} } } },
      newSession: async params => { this.opened.push(params); return { sessionId: "conversation" } },
      resume: async () => ({}),
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async () => ({ stopReason: "end_turn" }),
      steer: async () => ({ outcome: "inactive" }),
      cancel: async () => {},
      close: async () => {},
    }
  }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-session-cwd-"))
  const primary = join(directory, "primary")
  const secondary = join(directory, "secondary")
  const custom = join(directory, "custom")
  for (const path of [primary, secondary, custom]) await mkdir(path)
  const daemonDirectory = join(directory, "daemon")
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Directories", [{ path: primary }, { path: secondary }])
  const provider = new CwdProvider()
  const service = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
  })
  return { catalog, service, provider, workspace, primary, secondary, custom, actor: service.actor() }
}

test("machine-scoped Sessions use an explicit cwd instead of the home directory", async t => {
  const f = await setup(t)
  const created = await f.service.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider: "codex", context: "directory", cwd: f.custom,
  }, f.actor) as AgentSnapshot
  assert.equal(created.session.lifecycle, "ready")
  assert.equal(created.session.workspaceId, undefined)
  assert.deepEqual(f.provider.opened[0]?.cwd, f.custom)
  assert.equal((await f.catalog.sessionWorktree(created.session.id))!.directories[0]!.path, f.custom)
})

test("directory Sessions reorder a Workspace path chosen as cwd and keep the rest as additionalDirectories", async t => {
  const f = await setup(t)
  const created = await f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", cwd: f.secondary,
  }, f.actor) as AgentSnapshot
  assert.equal(created.session.lifecycle, "ready")
  assert.deepEqual(f.provider.opened[0], {
    cwd: f.secondary, mcpServers: [], additionalDirectories: [f.primary],
  })
})

test("directory Sessions accept a cwd outside the Workspace as the primary path", async t => {
  const f = await setup(t)
  const created = await f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", cwd: f.custom,
  }, f.actor) as AgentSnapshot
  assert.equal(created.session.lifecycle, "ready")
  assert.deepEqual(f.provider.opened[0], {
    cwd: f.custom, mcpServers: [], additionalDirectories: [f.primary, f.secondary],
  })
})

test("omitted cwd keeps the Workspace default and rejects invalid or worktree cwd values", async t => {
  const f = await setup(t)
  const defaults = await f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory",
  }, f.actor) as AgentSnapshot
  assert.equal(defaults.session.lifecycle, "ready")
  assert.equal(f.provider.opened[0]?.cwd, f.primary)

  await assert.rejects(f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", cwd: "relative",
  }, f.actor), /working directory/iu)
  await assert.rejects(f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "worktree", cwd: f.custom,
  }, f.actor), /working directory/iu)

  const missing = await f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", cwd: join(f.custom, "missing"),
  }, f.actor) as AgentSnapshot
  assert.equal(missing.session.lifecycle, "provision_failed")
  assert.match(missing.session.error ?? "", /Cannot access directory/u)

  await writeFile(join(f.custom, "file.txt"), "not a directory\n")
  const file = await f.service.handle("_deskfleet/session/create", {
    workspaceId: f.workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", cwd: join(f.custom, "file.txt"),
  }, f.actor) as AgentSnapshot
  assert.equal(file.session.lifecycle, "provision_failed")
  assert.match(file.session.error ?? "", /Not a directory/u)
})
