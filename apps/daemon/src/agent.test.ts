import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { agentConfiguration } from "./agent-configuration-protocol.ts"
import { canContinueSession, connectAcpProcess, supportsSteering, type AgentProcess } from "./agents/acp.ts"
import { authenticateCursor } from "./agents/cursor.ts"
import { authenticateGrok } from "./agents/grok.ts"

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

test("ACP advertises only handled form questions and forwards the original request and answer", { timeout: 15_000 }, async context => {
  const requests: acp.CreateElicitationRequest[] = []
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "elicitation" } }, {
    onUpdate() {},
    async requestElicitation(request, signal) {
      assert.equal(signal.aborted, false)
      requests.push(request)
      return { action: "accept", content: { direction: "left" } }
    },
  })
  context.after(() => connection.close())
  const capabilities = connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities
  assert.deepEqual(capabilities.elicitation, { form: {} })
  const created = await connection.newSession(session)
  const result = await connection.prompt({ sessionId: created.sessionId, prompt })
  assert.deepEqual(result._meta?.elicitation, { action: "accept", content: { direction: "left" } })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.ok("sessionId" in request)
  assert.equal(request.sessionId, created.sessionId)
  assert.equal(request.toolCallId, "question-1")
  assert.equal(request.mode, "form")
})

test("ACP cancels unsupported question modes, scopes, and missing handlers", { timeout: 15_000 }, async context => {
  for (const mode of ["elicitation", "elicitation-url", "elicitation-request"]) {
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: mode } }, {
      onUpdate() {},
      ...(mode === "elicitation" ? {} : { async requestElicitation() { assert.fail("Unsupported request reached form handler") } }),
    })
    context.after(() => connection.close())
    if (mode === "elicitation") assert.equal((connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities).elicitation, undefined)
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    assert.deepEqual(result._meta?.elicitation, { action: "cancel" })
    await connection.close()
  }
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

test("Cursor ACP authenticates and loads a saved session without replaying its history", { timeout: 15_000 }, async context => {
  const updates: acp.SessionNotification[] = []
  const connection = await connectAcpProcess({
    ...launch,
    env: { DESKFLEET_TEST_AGENT_MODE: "cursor" },
  }, { onUpdate: update => { updates.push(update) } }, { afterInitialize: authenticateCursor })
  context.after(() => connection.close())
  assert.equal(canContinueSession(connection.initialization), true)
  assert.equal(connection.initialization.agentCapabilities?.sessionCapabilities?.resume, undefined)
  const created = await connection.newSession(session)
  assert.equal(created._meta?.authenticated, true)
  assert.equal(agentConfiguration(created.configOptions ?? []).reasoningEfforts, null)
  const loaded = await connection.resume({ ...session, sessionId: created.sessionId })
  assert.equal(loaded._meta?.method, "session/load")
  assert.deepEqual(loaded._meta?.request, { ...session, sessionId: created.sessionId })
  assert.deepEqual(updates.map(update => update.update.sessionUpdate), ["config_option_update"])
  const unauthenticated = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor" },
  }, { onUpdate() {} })
  context.after(() => unauthenticated.close())
  await assert.rejects(unauthenticated.newSession(session), (error: unknown) => {
    const details = (error as { data?: { details?: string } }).data?.details ?? ""
    assert.match(details, /authenticate required/u)
    return true
  })
})

test("Cursor parameterized model options expose reasoning effort and apply it", { timeout: 15_000 }, async context => {
  const connection = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor" },
  }, { onUpdate() {} }, {
    afterInitialize: authenticateCursor,
    clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  })
  context.after(() => connection.close())
  assert.equal(connection.initialization._meta?.clientCapabilities &&
    (connection.initialization._meta.clientCapabilities as { _meta?: { parameterizedModelPicker?: boolean } })._meta?.parameterizedModelPicker, true)
  const created = await connection.newSession(session)
  const discovered = agentConfiguration(created.configOptions ?? [], { id: "cursor", name: "Cursor" })
  assert.equal(discovered.reasoningEfforts?.id, "effort")
  assert.deepEqual(discovered.reasoningEfforts?.options.map(option => option.id), ["low", "medium", "high", "xhigh"])
  assert.equal(discovered.modes, null)
  const changed = await connection.setConfigOption({
    sessionId: created.sessionId, configId: "effort", value: "low",
  }, created.configOptions ?? undefined)
  const configuration = agentConfiguration(changed.configOptions, { id: "cursor", name: "Cursor" })
  assert.equal(configuration.reasoningEfforts?.currentValue, "low")
  assert.equal(configuration.models?.currentValue, "composer-2.5")
})

test("Grok model metadata exposes reasoning effort and applies it with session/set_mode", { timeout: 15_000 }, async context => {
  const connection = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "grok-effort" },
  }, { onUpdate() {} })
  context.after(() => connection.close())
  const created = await connection.newSession(session)
  const discovered = agentConfiguration(created.configOptions ?? [], { id: "grok", name: "Grok" })
  assert.equal(discovered.models?.currentValue, "grok-4.5")
  assert.deepEqual(discovered.reasoningEfforts?.options.map(option => option.id), ["low", "medium", "high"])
  assert.equal(discovered.reasoningEfforts?.currentValue, "high")
  assert.equal(discovered.modes, null)
  const effort = await connection.setConfigOption({
    sessionId: created.sessionId, configId: discovered.reasoningEfforts!.id, value: "low",
  }, created.configOptions ?? undefined)
  const afterEffort = agentConfiguration(effort.configOptions, { id: "grok", name: "Grok" })
  assert.equal(afterEffort.reasoningEfforts?.currentValue, "low")
  assert.equal(afterEffort.models?.currentValue, "grok-4.5")
  assert.deepEqual(afterEffort.models?.options.map(option => option.id), ["grok-4.5", "grok-fast"])
  const model = await connection.setConfigOption({
    sessionId: created.sessionId, configId: "model", value: "grok-fast",
  }, effort.configOptions)
  const afterModel = agentConfiguration(model.configOptions, { id: "grok", name: "Grok" })
  assert.equal(afterModel.models?.currentValue, "grok-fast")
  assert.deepEqual(afterModel.models?.options.map(option => option.id), ["grok-4.5", "grok-fast"])
  assert.equal(afterModel.reasoningEfforts, null)
  assert.equal(afterModel.modes, null)
})

test("Grok ACP prefers an API key, then a cached login, and skips interactive auth", { timeout: 15_000 }, async context => {
  const key = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "grok" },
  }, { onUpdate() {} }, { afterInitialize: (initialization, agent) => authenticateGrok(initialization, agent, { XAI_API_KEY: "present" }) })
  context.after(() => key.close())
  const created = await key.newSession(session)
  assert.equal(created._meta?.authMethod, "xai.api_key")
  assert.equal(created._meta?.headless, true)

  const cached = await connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "grok-cached" },
  }, { onUpdate() {} }, { afterInitialize: (initialization, agent) => authenticateGrok(initialization, agent, {}) })
  context.after(() => cached.close())
  const resumed = await cached.newSession(session)
  assert.equal(resumed._meta?.authMethod, "cached_token")

  await assert.rejects(connectAcpProcess({
    ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "grok-login" },
  }, { onUpdate() {} }, { afterInitialize: (initialization, agent) => authenticateGrok(initialization, agent, { XAI_API_KEY: "present" }) }), /grok login/u)
})

test("Cursor and Grok questions use the session form", { timeout: 30_000 }, async context => {
  await context.test("cursor ask_question", async () => {
    const requests: acp.CreateElicitationRequest[] = []
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-question" } }, {
      onUpdate() {},
      async requestElicitation(request) {
        requests.push(request)
        return { action: "accept", content: { q1: "agent", q2: ["lint"] } }
      },
    })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    const request = requests[0]
    assert.ok(request && "sessionId" in request && "toolCallId" in request)
    assert.equal(request.sessionId, created.sessionId)
    assert.equal(request.toolCallId, "call_123")
    assert.deepEqual(result._meta?.question, { outcome: { outcome: "answered", answers: [
      { questionId: "q1", selectedOptionIds: ["agent"] },
      { questionId: "q2", selectedOptionIds: ["lint"] },
    ] } })
  })

  await context.test("cursor question without a handler", async () => {
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-question" } }, { onUpdate() {} })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    const questionError = result._meta?.questionError
    assert.ok(questionError && typeof questionError === "object" && "code" in questionError)
    assert.equal(questionError.code, -32601)
  })

  await context.test("malformed cursor question", async () => {
    let asked = false
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-question-invalid" } }, {
      onUpdate() {},
      async requestElicitation() { asked = true; return { action: "cancel" } },
    })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    assert.equal(asked, false)
    assert.deepEqual(result._meta?.question, { outcome: { outcome: "cancelled" } })
  })

  await context.test("cursor create_plan", async () => {
    const requests: acp.CreateElicitationRequest[] = []
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-plan" } }, {
      onUpdate() {},
      async requestElicitation(request) {
        requests.push(request)
        return { action: "accept", content: {} }
      },
    })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    const request = requests[0]
    assert.ok(request && "sessionId" in request && "toolCallId" in request)
    assert.equal(request.sessionId, created.sessionId)
    assert.equal(request.toolCallId, "call_124")
    assert.equal(request.message, "Tighten layout behavior and preserve existing UX.")
    assert.ok(request._meta?.deskfleet && typeof request._meta.deskfleet === "object" && "cursorPlan" in request._meta.deskfleet)
    assert.deepEqual(result._meta?.question, { outcome: { outcome: "accepted" } })
  })

  await context.test("cursor create_plan without a handler", async () => {
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-plan" } }, { onUpdate() {} })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    const questionError = result._meta?.questionError
    assert.ok(questionError && typeof questionError === "object" && "code" in questionError)
    assert.equal(questionError.code, -32601)
  })

  await context.test("malformed cursor create_plan", async () => {
    let asked = false
    const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-plan-invalid" } }, {
      onUpdate() {},
      async requestElicitation() { asked = true; return { action: "cancel" } },
    })
    context.after(() => connection.close())
    const created = await connection.newSession(session)
    const result = await connection.prompt({ sessionId: created.sessionId, prompt })
    assert.equal(asked, false)
    assert.deepEqual(result._meta?.question, { outcome: { outcome: "cancelled" } })
  })

  await context.test("grok ask_user_question", async () => {
    for (const mode of ["grok-question", "grok-question-alias"]) {
      const requests: acp.CreateElicitationRequest[] = []
      const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_AGENT_MODE: mode } }, {
        onUpdate() {},
        async requestElicitation(request) {
          requests.push(request)
          return mode === "grok-question" ? { action: "accept", content: { "Which database?": "Redis" } } : { action: "cancel" }
        },
      })
      context.after(() => connection.close())
      const created = await connection.newSession(session)
      const result = await connection.prompt({ sessionId: created.sessionId, prompt })
      const request = requests[0]
      assert.ok(request && "sessionId" in request)
      assert.equal(request.sessionId, created.sessionId)
      assert.deepEqual(result._meta?.question, mode === "grok-question"
        ? { outcome: "accepted", answers: { "Which database?": ["Redis"] }, annotations: { "Which database?": { preview: " redis preview " } } }
        : { outcome: "cancelled" })
      await connection.close()
    }
  })
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
