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
