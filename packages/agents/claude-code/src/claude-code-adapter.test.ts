import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { supportsSteering } from "@deskfleet/agent-core"

const claude = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/v1/acp-agent.js"), "utf8")

function method(source: string, name: string, indent: number): (this: unknown, ...args: unknown[]) => Promise<unknown> {
  const spaces = " ".repeat(indent)
  const matched = source.match(new RegExp(`^${spaces}(async )?${name}\\([^\\n]*\\) \\{[\\s\\S]*?^${spaces}\\}`, "m"))
  assert.ok(matched, `Installed adapter method ${name} exists`)
  return runInNewContext(`(${matched[0].trimStart().replace(name, `function ${name}`)})`) as (this: unknown, ...args: unknown[]) => Promise<unknown>
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
