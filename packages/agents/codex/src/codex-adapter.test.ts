import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const adapter = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8")

function method(source: string, name: string, indent: number, globals: Record<string, unknown> = {}): (this: unknown, ...args: unknown[]) => unknown {
  const spaces = " ".repeat(indent)
  const matched = source.match(new RegExp(`^${spaces}(async )?${name}\\([^\\n]*\\) \\{[\\s\\S]*?^${spaces}\\}`, "m"))
  assert.ok(matched, `Installed adapter method ${name} exists`)
  return runInNewContext(`(${matched[0].trimStart().replace(name, `function ${name}`)})`, globals) as (this: unknown, ...args: unknown[]) => unknown
}

test("patched Codex steering preserves the opt-in and never starts a detached fallback", async context => {
  const globals = { logger: { log() {} }, randomUUID5: randomUUID }
  const parse = method(adapter, "parseSessionSteerParams", 2, globals)
  const perform = method(adapter, "performSteeringRequest", 2, globals)
  const request = {
    sessionId: "codex-session",
    prompt: [{ type: "text", text: "Change direction" }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  }
  const parsed = parse.call(undefined, request)
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

test("the installed Codex bridge emits current child association and work-state updates", async () => {
  const events: unknown[] = []
  const start = adapter.indexOf("var CodexSubagentEventRouter = class ")
  const router = adapter.slice(start, adapter.indexOf("\n};", start))
  const helper = adapter.match(/^function subagentWorkState\(state\) \{[\s\S]*?^\}/m)
  assert.ok(helper)
  const globals = {
    nameFromAgentPath: () => "Explorer", fallbackName: () => "Explorer", preferredModel: () => undefined,
    normalizeAgentPath: (path: unknown) => path,
    subagentWorkState: runInNewContext(`(${helper[0]})`),
  }
  const state = {
    children: new Map(), pendingSpawns: new Map(), replayQueue: [],
    parentForPath: () => ({ threadId: "root", sessionId: "root" }), takeEarlyModel() {},
    session: { update: async (update: unknown, sessionId: string) => { events.push({ sessionId, update }) } },
    resolveMaterialization() {}, reportModel: async () => {}, onChildSessionEnded() {}, notifyWaiters() {},
  }
  await method(router, "materialize", 2, globals).call(state, "child", ["child"], undefined)
  await method(router, "finish", 2, globals).call(state, "child", "completed")
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { sessionId: "root", update: { sessionUpdate: "subagent_update", sessionId: "child", title: "Explorer", description: "Delegated task for Explorer", capabilities: {}, state: { state: "running" } } },
    { sessionId: "root", update: { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "idle", stopReason: "end_turn" } } },
  ])
})
