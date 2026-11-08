import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { connectAcpProcess, type AgentClient, type AgentConnection } from "./agents/acp.ts"

const fixture = fileURLToPath(new URL("./fixtures/acp-extensions-agent.ts", import.meta.url))
const prompt = [{ type: "text" as const, text: "Exercise client extensions" }]

async function connect(context: TestContext, client: AgentClient = { onUpdate() {} }, mode?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-acp-extensions-"))
  const connection = await connectAcpProcess({
    command: process.execPath, args: [fixture], env: { DESKFLEET_TEST_EXTENSIONS_MODE: mode },
  }, client)
  context.after(async () => { await connection.close(); await rm(cwd, { recursive: true, force: true }) })
  return { connection, cwd }
}

async function callback(connection: AgentConnection, sessionId: string, method: string, params: Record<string, unknown>) {
  const result = await connection.prompt({ sessionId, prompt, _meta: { operation: { method, params } } })
  return result._meta?.callback as { result?: unknown; error?: { code: number; message: string } }
}

test("ACP advertises filesystem support and serves callbacks before and after session/new returns", { timeout: 15_000 }, async context => {
  const { connection, cwd } = await connect(context)
  const capabilities = connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities
  assert.deepEqual(capabilities.fs, { readTextFile: true, writeTextFile: true })
  assert.equal(capabilities.elicitation, undefined)
  const created = await connection.newSession({ cwd, mcpServers: [] })
  assert.equal(created._meta?.content, "ready\n")
  assert.equal(await readFile(join(cwd, "opening", `${created.sessionId}.txt`), "utf8"), `${created.sessionId}\nready\n`)
  const path = join(cwd, "nested", "notes.txt")
  assert.deepEqual(await callback(connection, created.sessionId, "fs/write_text_file", { path, content: "first\r\n第二行\nlast" }), { result: {} })
  assert.deepEqual(await callback(connection, created.sessionId, "fs/read_text_file", { path, line: 2, limit: 1 }), { result: { content: "第二行\n" } })
})

test("ACP rejects wrong-session and relative filesystem requests without poisoning the connection", { timeout: 15_000 }, async context => {
  const closed: Error[] = []
  const { connection, cwd } = await connect(context, { onUpdate() {}, onClose: reason => { closed.push(reason) } })
  const { sessionId } = await connection.newSession({ cwd, mcpServers: [] })
  const path = join(cwd, "opening", `${sessionId}.txt`)
  for (const method of ["fs/read_text_file", "fs/write_text_file"]) {
    for (const params of [{ sessionId: "unrelated-session", path }, { path: "." }]) {
      const response = await callback(connection, sessionId, method, { ...params, content: "must not be written" })
      assert.equal(response.error?.code, -32602)
    }
  }
  assert.deepEqual(await callback(connection, sessionId, "fs/read_text_file", { path }), { result: { content: `${sessionId}\nready\n` } })
  assert.deepEqual(closed, [])
})

test("ACP fork uses the source ID and binds early callbacks to the distinct destination", { timeout: 15_000 }, async context => {
  const { connection, cwd } = await connect(context)
  const source = await connection.newSession({ cwd, mcpServers: [] })
  const params: acp.ForkSessionRequest = {
    sessionId: source.sessionId, cwd: join(cwd, "destination"), additionalDirectories: [join(cwd, "extra")], mcpServers: [],
    _meta: { source: "copied-conversation" },
  }
  const forked = await connection.forkSession!(params)
  assert.notEqual(forked.sessionId, source.sessionId)
  assert.deepEqual(forked._meta?.request, params)
  assert.equal(forked._meta?.content, "ready\n")
  const path = join(params.cwd, "opening", `${forked.sessionId}.txt`)
  assert.deepEqual(await callback(connection, forked.sessionId, "fs/read_text_file", { path }), { result: { content: `${forked.sessionId}\nready\n` } })
  assert.equal((await callback(connection, forked.sessionId, "fs/read_text_file", { sessionId: source.sessionId, path })).error?.code, -32602)
  assert.deepEqual(await callback(connection, forked.sessionId, "fs/write_text_file", { path, content: "fork only" }), { result: {} })
  assert.equal(await readFile(join(cwd, "opening", `${source.sessionId}.txt`), "utf8"), `${source.sessionId}\nready\n`)
})

test("ACP can fork a saved source on a fresh connection without creating an empty session first", { timeout: 15_000 }, async context => {
  const { connection, cwd } = await connect(context)
  const forked = await connection.forkSession!({ sessionId: "saved-source", cwd, mcpServers: [] })
  assert.equal(forked.sessionId, "extension-fork-1")
  assert.equal(forked._meta?.content, "ready\n")
  assert.equal((forked._meta?.request as acp.ForkSessionRequest).sessionId, "saved-source")
})

test("ACP rejects an unsupported fork locally and a reused or mismatched destination while preserving source access", { timeout: 30_000 }, async context => {
  for (const [mode, error] of [["unsupported-fork", /does not support session fork/u], ["same-id", /source session/u], ["mismatched-id", { code: -32602, data: { details: "ACP session response does not match its client callbacks" } }]] as const) {
    await context.test(mode, async nested => {
      const { connection, cwd } = await connect(nested, { onUpdate() {} }, mode)
      const source = await connection.newSession({ cwd, mcpServers: [] })
      await assert.rejects(connection.forkSession!({ sessionId: source.sessionId, cwd, mcpServers: [] }), error)
      const path = join(cwd, "opening", `${source.sessionId}.txt`)
      assert.deepEqual(await callback(connection, source.sessionId, "fs/read_text_file", { path }), { result: { content: `${source.sessionId}\nready\n` } })
      const audit = await connection.prompt({ sessionId: source.sessionId, prompt })
      assert.equal(audit._meta?.forkCalls, mode === "unsupported-fork" ? 0 : 1)
    })
  }
})

test("ACP advertises URL elicitation only with its completion handler and forwards completion independently", { timeout: 30_000 }, async context => {
  for (const handlesRequest of [false, true]) for (const handlesComplete of [false, true]) {
    await context.test(`request=${handlesRequest}, completion=${handlesComplete}`, async nested => {
      const requests: acp.CreateElicitationRequest[] = []
      let complete!: (notification: acp.CompleteElicitationNotification) => void
      const completed = new Promise<acp.CompleteElicitationNotification>(resolve => { complete = resolve })
      const { connection, cwd } = await connect(nested, {
        onUpdate() {},
        ...(handlesRequest ? { requestElicitation: async (request: acp.CreateElicitationRequest) => { requests.push(request); return { action: "accept" as const } } } : {}),
        ...(handlesComplete ? { completeElicitation: (notification: acp.CompleteElicitationNotification) => { complete(notification) } } : {}),
      })
      const capabilities = connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities
      assert.deepEqual(capabilities.elicitation, handlesRequest ? { form: {}, ...(handlesComplete ? { url: {} } : {}) } : undefined)
      const { sessionId } = await connection.newSession({ cwd, mcpServers: [] })
      const result = await connection.prompt({ sessionId, prompt, _meta: { url: true } })
      const supported = handlesRequest && handlesComplete
      assert.deepEqual(result._meta?.response, { action: supported ? "accept" : "cancel" })
      assert.equal(requests.length, supported ? 1 : 0)
      if (supported) {
        assert.deepEqual(requests[0], { sessionId, mode: "url", elicitationId: "authorize-account", url: "https://example.com/authorize", message: "Connect your account" })
        assert.deepEqual(await completed, { elicitationId: "authorize-account", _meta: { completed: true } })
      }
    })
  }
})

test("structured capabilities are advertised only when their consumer opts in", async context => {
  for (const enabled of [false, true]) {
    const { connection } = await connect(context, { onUpdate() {}, capabilities: {
      configOptions: enabled, notices: enabled, compaction: enabled, plans: enabled, subagents: enabled,
    } })
    const caps = connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities
    assert.deepEqual(caps.session, enabled ? { configOptions: { boolean: {} }, notices: {}, compaction: {} } : {})
    assert.deepEqual(caps.plan, enabled ? {} : undefined)
    assert.deepEqual(caps.subagents, enabled ? {} : undefined)
  }
})

test("announced child callbacks work during new/fork/load without admitting unknown sessions", async context => {
  const updates: acp.SessionNotification[] = []
  const { connection, cwd } = await connect(context, { capabilities: { subagents: true },
    onUpdate: notification => { updates.push(notification) }, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  }, "children")
  const source = await connection.newSession({ cwd, mcpServers: [] })
  assert.ok(updates.some(event => event.sessionId === `${source.sessionId}-child`))
  const forked = await connection.forkSession!({ cwd, mcpServers: [], sessionId: source.sessionId })
  const childId = `${forked.sessionId}-child`
  const path = join(cwd, "opening", `${childId}.txt`)
  assert.deepEqual(await callback(connection, forked.sessionId, "fs/read_text_file", { sessionId: childId, path }),
    { result: { content: `${childId}\nready\n` } })
  assert.equal((await callback(connection, forked.sessionId, "fs/read_text_file", { sessionId: `${source.sessionId}-child`, path })).error?.code, -32602)
  assert.equal((await callback(connection, forked.sessionId, "session/request_permission", {
    sessionId: "unannounced", toolCall: { toolCallId: "tool" }, options: [],
  })).error?.code, -32602)
  updates.length = 0
  await connection.resume({ sessionId: "saved", cwd, mcpServers: [] })
  assert.deepEqual(updates.map(event => event.update.sessionUpdate), ["subagent_update"])
  assert.deepEqual(await callback(connection, "saved", "fs/read_text_file", {
    sessionId: "saved-child", path: join(cwd, "opening", "saved-child.txt"),
  }), { result: { content: "saved-child\nready\n" } })
})

test("auth notifications expose identity fields without vendor secrets", { timeout: 15_000 }, async context => {
  const received: unknown[] = []
  let receive!: () => void
  const receivedStatus = new Promise<void>(resolve => { receive = resolve })
  const { connection, cwd } = await connect(context, { onUpdate() {}, onAuthStatus: status => { received.push(status); receive() } })
  const { sessionId } = await connection.newSession({ cwd, mcpServers: [] })
  await connection.prompt({ sessionId, prompt, _meta: { notification: { method: "_auth/status_update", params: {
    authStatus: { kind: "account", label: "Account", detail: "Signed in", account: { email: "a@example.com", plan: "Pro", token: "secret" }, vendor: { token: "secret" } },
  } } } })
  await receivedStatus
  assert.deepEqual(received, [{ kind: "account", label: "Account", detail: "Signed in", account: { email: "a@example.com", plan: "Pro" } }])
})

test("Cursor notifications reach the active session as structured events", { timeout: 15_000 }, async context => {
  const updates: acp.SessionNotification[] = []
  let receive!: () => void
  const receivedUpdates = new Promise<void>(resolve => { receive = resolve })
  const { connection, cwd } = await connect(context, { capabilities: { plans: true },
    onUpdate: notification => { updates.push(notification); if (updates.length === 3) receive() },
  })
  const { sessionId } = await connection.newSession({ cwd, mcpServers: [] })
  for (const notification of [
    { method: "cursor/update_todos", params: { toolCallId: "todos-1", merge: false,
      todos: [{ id: "task-1", content: "Inspect routes", status: "pending" }] } },
    { method: "cursor/task", params: { toolCallId: "task-call-1", description: "Inspect routes", prompt: "Find all routes", subagentType: "explore" } },
    { method: "cursor/generate_image", params: { toolCallId: "image-1", description: "Architecture", filePath: join(cwd, "architecture.png") } },
  ]) await connection.prompt({ sessionId, prompt, _meta: { notification } })
  await receivedUpdates
  assert.deepEqual(updates.map(event => [event.sessionId, event.update.sessionUpdate]), [
    [sessionId, "plan_update"], [sessionId, "tool_call"], [sessionId, "tool_call"],
  ])
  assert.equal(updates[1]!.update.sessionUpdate === "tool_call" && updates[1]!.update.toolCallId, "task-call-1")
  assert.equal(updates[2]!.update.sessionUpdate === "tool_call" && updates[2]!.update.toolCallId, "image-1")
})
