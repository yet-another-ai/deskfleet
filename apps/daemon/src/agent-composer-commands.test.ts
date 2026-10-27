import assert from "node:assert/strict"
import test from "node:test"
import { AgentComposerCommands } from "./agent-composer-commands.ts"
import { agentComposerCatalog } from "./agent-configuration-protocol.ts"

test("composer catalogs preserve native commands and recognize only provider-confirmed skills", () => {
  const available = [
    { name: "review", description: "Review changes", input: { hint: "instructions" } },
    { name: "$rust-skills", description: "Rust guidance" },
    { name: "skill:release", description: "Prepare release" },
  ]
  assert.deepEqual(agentComposerCatalog(available, "codex"), {
    commands: [{ name: "review", description: "Review changes", inputHint: "instructions" },
      { name: "skill:release", description: "Prepare release" }],
    skills: [{ id: "$rust-skills", name: "rust-skills", description: "Rust guidance", invocation: "$rust-skills" }],
  })
  assert.deepEqual(agentComposerCatalog(available, "pi").skills, [
    { id: "skill:release", name: "release", description: "Prepare release", invocation: "/skill:release" },
  ])
  assert.deepEqual(agentComposerCatalog(available, "acp").skills, [])
})

test("Claude commands become skills only with the adapter's explicit skill metadata", () => {
  const available = [{ name: "release", description: "Prepare release" }, {
    name: "review", description: "Review work", _meta: { jetbrains: { air: { kind: "skill", skillPath: "/skills/review/SKILL.md" } } },
  }]
  assert.deepEqual(agentComposerCatalog(available, "claude-code"), {
    commands: [{ name: "release", description: "Prepare release" }],
    skills: [{ id: "review", name: "review", description: "Review work", invocation: "/review" }],
  })
  assert.deepEqual(agentComposerCatalog(available, "acp").skills, [])
})

test("initial command discovery waits for the notification and later empty catalogs replace it", async () => {
  const commands = new AgentComposerCommands()
  const ready = commands.ready()
  commands.update([{ name: "review", description: "Review changes" }])
  await ready
  assert.equal(commands.current?.[0]?.name, "review")
  commands.update([])
  await commands.ready()
  assert.deepEqual(commands.current, [])
  commands.close()
})

test("command discovery has a bounded wait and closes or cancels without leaving a timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const timed = new AgentComposerCommands()
  const ready = timed.ready(undefined, 100)
  t.mock.timers.tick(100)
  await ready
  assert.equal(timed.current, undefined)
  timed.close()

  const closing = new AgentComposerCommands()
  const stopped = assert.rejects(closing.ready(), /discovery was stopped/)
  closing.close()
  await stopped

  const cancelled = new AgentComposerCommands()
  const controller = new AbortController()
  const aborted = assert.rejects(cancelled.ready(controller.signal), /cancelled by caller/)
  controller.abort(new Error("cancelled by caller"))
  await aborted
  cancelled.update([])
  await cancelled.ready()
  cancelled.close()
  t.mock.timers.tick(2_000)
})
