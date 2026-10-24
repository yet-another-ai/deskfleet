import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { connectAcpProcess, type AgentProcess } from "./agents/acp.ts"

const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
const launch: AgentProcess = { command: process.execPath, args: [fixture] }
const session = { cwd: process.cwd(), mcpServers: [] }
const prompt = [{ type: "text" as const, text: "Hello" }]

test("ACP forwards session context, updates, and permission decisions", { timeout: 15_000 }, async context => {
  const updates: acp.SessionNotification[] = []
  const permissions: acp.RequestPermissionRequest[] = []
  const connection = await connectAcpProcess({
    ...launch,
    env: { LANG: "deskfleet-test", DESKFLEET_TEST_VALUE: "added" },
  }, {
    onUpdate: update => updates.push(update),
    requestPermission: async (request, signal) => {
      assert.equal(signal.aborted, false)
      permissions.push(request)
      return { outcome: { outcome: "selected", optionId: "allow" } }
    },
  })
  context.after(() => connection.close())
  assert.equal(connection.initialization.agentInfo?.name, "deskfleet-test-agent")
  const capabilities = connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities
  assert.notEqual(capabilities.fs?.readTextFile, true)
  assert.notEqual(capabilities.fs?.writeTextFile, true)
  assert.notEqual(capabilities.terminal, true)
  assert.deepEqual(connection.initialization._meta?.environment, {
    PATH: process.env.PATH, LANG: "deskfleet-test", extra: "added",
  })

  const request: acp.NewSessionRequest = {
    cwd: join(process.cwd(), "frontend"),
    additionalDirectories: [join(process.cwd(), "backend")],
    mcpServers: [{ name: "tools", command: "example-mcp", args: ["--stdio"], env: [] }],
    _meta: { workspace: "workspace-1" },
  }
  const created = await connection.newSession(request)
  assert.deepEqual(created._meta?.request, request)
  const configured = await connection.setConfigOption({ sessionId: created.sessionId, configId: "model", value: "other-model" })
  assert.equal(configured.configOptions[0]?.currentValue, "other-model")
  const result = await connection.prompt({ sessionId: created.sessionId, prompt })
  assert.deepEqual(result, {
    stopReason: "end_turn",
    _meta: { prompt, permission: { outcome: { outcome: "selected", optionId: "allow" } } },
  })
  assert.equal(permissions[0]?.sessionId, created.sessionId)
  assert.equal(permissions[0]?.toolCall.toolCallId, "write-1")
  assert.deepEqual(updates, [{
    sessionId: created.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } },
    _meta: { source: "fixture" },
  }])
})

test("ACP cancels permissions when no decision handler is installed", { timeout: 15_000 }, async context => {
  const connection = await connectAcpProcess(launch, { onUpdate() {} })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  const result = await connection.prompt({ sessionId: created.sessionId, prompt })
  assert.deepEqual(result._meta?.permission, { outcome: { outcome: "cancelled" } })
})

test("ACP cancellation and close settle active prompts and stop the process", { timeout: 30_000 }, async context => {
  for (const action of ["cancel", "close"] as const) {
    await context.test(action, async () => {
      const directory = mkdtempSync(join(tmpdir(), "deskfleet-acp-"))
      const exitFile = join(directory, "exit")
      let ready!: () => void
      const started = new Promise<void>(resolve => { ready = resolve })
      const connection = await connectAcpProcess({
        ...launch,
        env: { DESKFLEET_TEST_AGENT_MODE: "wait", DESKFLEET_TEST_EXIT_FILE: exitFile },
      }, { onUpdate: ready })
      try {
        const created = await connection.newSession(session)
        const pending = connection.prompt({ sessionId: created.sessionId, prompt })
        await started
        if (action === "cancel") {
          await connection.cancel(created.sessionId)
          assert.equal((await pending).stopReason, "cancelled")
        } else {
          const rejected = assert.rejects(pending)
          await connection.close()
          await rejected
        }
        await connection.close()
        assert.equal(readFileSync(exitFile, "utf8"), "0")
      } finally {
        await connection.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})

test("ACP rejects unavailable, exited, or incompatible agents", { timeout: 30_000 }, async context => {
  const cases: [string, AgentProcess, RegExp][] = [
    ["missing executable", { command: join(tmpdir(), "deskfleet-missing-agent", "agent") }, /ENOENT|Could not start/i],
    ["exit during initialize", { ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "exit-init" } }, /closed|exit/i],
    ["unsupported protocol", { ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "wrong-version" } }, /protocol version/i],
  ]
  for (const [name, command, error] of cases) {
    await context.test(name, () => assert.rejects(connectAcpProcess(command, { onUpdate() {} }), error))
  }
})

test("ACP propagates an update consumer failure to the active prompt", { timeout: 15_000 }, async context => {
  const connection = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "wait" },
  }, { onUpdate() { throw new Error("cannot store update") } })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  await assert.rejects(connection.prompt({ sessionId: created.sessionId, prompt }), /cannot store update/)
})

test("ACP abort during initialization stops the child process", { timeout: 15_000 }, async context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-acp-abort-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const exitFile = join(directory, "exit")
  const controller = new AbortController()
  const pending = connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "wait-init", DESKFLEET_TEST_EXIT_FILE: exitFile },
  }, { onUpdate() {}, signal: controller.signal })
  const rejected = assert.rejects(pending, /disconnected/)
  setTimeout(() => controller.abort(new Error("disconnected")), 500)
  await rejected
  assert.equal(readFileSync(exitFile, "utf8"), "0")
})
