import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { connectAcpProcess, supportsSteering, type AgentProcess } from "./agents/acp.ts"

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
    onUpdate: update => { updates.push(update) },
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
  const closed: Error[] = []
  const connection = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "wait" },
  }, {
    async onUpdate() { await Promise.resolve(); throw new Error("cannot store update") },
    onClose: reason => { closed.push(reason) },
  })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  await assert.rejects(connection.prompt({ sessionId: created.sessionId, prompt }), /cannot store update/)
  await connection.close()
  assert.equal(closed.length, 1)
  assert.equal(closed[0]?.message, "cannot store update")
})

test("ACP resumes its captured context and steers without ending the active prompt", { timeout: 15_000 }, async context => {
  const updates: acp.SessionNotification[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "wait" } }, {
    onUpdate(update) { updates.push(update); ready() },
  })
  context.after(() => connection.close())
  assert.equal(supportsSteering(connection.initialization), true)
  const created = await connection.newSession(session)
  const request = { ...session, sessionId: created.sessionId, additionalDirectories: [join(process.cwd(), "backend")] }
  assert.deepEqual((await connection.resume(request))._meta?.request, request)
  const pending = connection.prompt({ sessionId: created.sessionId, prompt })
  let finished = false
  void pending.then(() => { finished = true })
  await started
  assert.deepEqual(await connection.steer({ sessionId: created.sessionId, prompt }, "delivery-1"), { outcome: "injected" })
  assert.equal(finished, false)
  const delivered = updates.find(update => update.update.sessionUpdate === "user_message_chunk")
  assert.deepEqual(delivered?._meta?.deskfleet, { deliveryId: "delivery-1" })
  await connection.cancel(created.sessionId)
  assert.equal((await pending).stopReason, "cancelled")
  assert.deepEqual(await connection.steer({ sessionId: created.sessionId, prompt }, "delivery-2"), { outcome: "inactive" })
})

test("ACP steering handles a completed target without starting an untracked prompt", { timeout: 15_000 }, async context => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const updates: acp.SessionNotification[] = []
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "steer-end-race" } }, {
    onUpdate(update) { updates.push(update); ready() },
  })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  const pending = connection.prompt({ sessionId: created.sessionId, prompt })
  await started
  assert.deepEqual(await connection.steer({ sessionId: created.sessionId, prompt }, "delivery-race"), { outcome: "inactive" })
  assert.equal((await pending).stopReason, "end_turn")
  assert.equal(updates.length, 1)
  // The host explicitly starts a tracked normal prompt after an inactive steer.
  const resumed = connection.prompt({ sessionId: created.sessionId, prompt })
  await connection.cancel(created.sessionId)
  assert.equal((await resumed).stopReason, "cancelled")
})

test("ACP steering rejects unsupported and unconfirmed delivery", { timeout: 15_000 }, async context => {
  for (const [mode, error] of [["legacy-steering", /does not support/], ["steer-failed", /not confirmed/]] as const) {
    await context.test(mode, async () => {
      const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: mode } }, { onUpdate() {} })
      try {
        const created = await connection.newSession(session)
        assert.equal(supportsSteering(connection.initialization), mode !== "legacy-steering")
        await assert.rejects(connection.steer({ sessionId: created.sessionId, prompt }, "delivery-failed"), error)
      } finally { await connection.close() }
    })
  }
})

test("ACP process loss reports closure once and rejects pending prompt and steering", { timeout: 15_000 }, async context => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const closed: Error[] = []
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "steer-exit" } }, {
    onUpdate: ready,
    onClose: error => { closed.push(error) },
  })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  const pending = connection.prompt({ sessionId: created.sessionId, prompt })
  const promptRejected = assert.rejects(pending, /closed|exited/)
  await started
  await assert.rejects(connection.steer({ sessionId: created.sessionId, prompt }, "delivery-lost"), /closed|exited/)
  await promptRejected
  await connection.close()
  assert.equal(closed.length, 1)
})

const adapter = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8")

// The published adapter only exports its executable. Exercise the patched methods
// themselves with a fake provider, without booting Codex or copying their logic.
function patchedMethod(name: string): (this: unknown, params: unknown) => unknown {
  const match = adapter.match(new RegExp(`^  (async )?${name}\\(params\\) \\{[\\s\\S]*?^  \\}`, "m"))
  assert.ok(match, `Pinned adapter method ${name} exists`)
  return runInNewContext(`(${match[0].trimStart().replace(name, `function ${name}`)})`, {
    logger: { log() {} },
  }) as (this: unknown, params: unknown) => unknown
}

test("patched Codex steering preserves the opt-in and never starts a detached fallback", async context => {
  const parse = patchedMethod("parseSessionSteerParams")
  const perform = patchedMethod("performSteeringRequest")
  const request = {
    sessionId: "codex-session",
    prompt: [{ type: "text", text: "Change direction" }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  }
  const parsed = parse(request)
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), request)
  for (const scenario of ["active", "idle", "ended-during-injection"] as const) {
    await context.test(scenario, async () => {
      let fallback = 0
      let injected = 0
      const provider = {
        getSessionState: () => ({}),
        assertSteerInputSupported() {},
        getSteerableTurnId: async () => scenario === "idle" ? null : "provider-turn",
        injectSteerIntoActiveTurn: async () => { injected++; return scenario === "active" },
        startNewTurnFromSteering: async () => { fallback++; return { outcome: "startedNewTurn" } },
      }
      const result = await perform.call(provider, parsed)
      assert.equal((result as { outcome: string }).outcome, scenario === "active" ? "injected" : "promptRequired")
      assert.equal(fallback, 0)
      assert.equal(injected, scenario === "idle" ? 0 : 1)
    })
  }
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
