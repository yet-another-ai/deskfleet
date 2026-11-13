import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { supportsSteering } from "./agents/acp.ts"

const require = createRequire(import.meta.url)
const codex = readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8")
const claude = readFileSync(require.resolve("@agentclientprotocol/claude-agent-acp/dist/v1/acp-agent.js"), "utf8")

function method(source: string, name: string, indent: number, globals: Record<string, unknown> = {}): (...args: unknown[]) => Promise<unknown> {
  const spaces = " ".repeat(indent)
  const matched = source.match(new RegExp(`^${spaces}(async )?${name}\\([^\\n]*\\) \\{[\\s\\S]*?^${spaces}\\}`, "m"))
  assert.ok(matched, `Installed adapter method ${name} exists`)
  return runInNewContext(`(${matched[0].trimStart().replace(name, `function ${name}`)})`, globals)
}

test("the installed Claude bridge advertises guarded steering and returns idle input to its host", async () => {
  const advertised = claude.match(/steering: (\{\s*supported: true,\s*supportsPromptRequired: true,\s*\})/u)
  assert.ok(advertised)
  assert.equal(supportsSteering({ protocolVersion: 1, _meta: { steering: runInNewContext(`(${advertised[1]})`) } }), true)
  const steer = method(claude, "steer", 4)
  const session = { turnQueue: [] }
  let prompted = false
  const result = await steer.call({ sessions: { root: session }, respawnSignedOutSession() {}, prompt() { prompted = true } }, {
    sessionId: "root", prompt: [{ type: "text", text: "Follow up" }], _meta: { steering: { idleBehavior: "promptRequired" } },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { outcome: "promptRequired", reason: "noRunningTurn" })
  assert.equal(prompted, false)
  assert.deepEqual(session.turnQueue, [])
})

test("the installed Codex bridge emits current child association and work-state updates", async () => {
  const events: unknown[] = []
  const start = codex.indexOf("var CodexSubagentEventRouter = class ")
  const router = codex.slice(start, codex.indexOf("\n};", start))
  const helper = codex.match(/^function subagentWorkState\(state\) \{[\s\S]*?^\}/m)
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
