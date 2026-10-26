import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { connectAcpProcess } from "./agents/acp.ts"
import { applyAgentConfiguration } from "./agent-configuration.ts"
import { AcpSessionModes, withRestoredSessionMode } from "./agents/session-modes.ts"

const launch = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/acp-mode-agent.ts", import.meta.url))],
}
const session = { cwd: process.cwd(), mcpServers: [] }
const selectedMode = (options?: acp.SessionConfigOption[] | null) => options?.find(option => option.category === "mode")?.currentValue

test("ACP advertised modes use native set_mode and survive model catalog updates and resume", { timeout: 15_000 }, async t => {
  const updates: acp.SessionNotification[] = []
  const connection = await connectAcpProcess(launch, { onUpdate: update => { updates.push(update) } })
  t.after(() => connection.close())
  const created = await connection.newSession(session)
  assert.equal(selectedMode(created.configOptions), "default")
  const mode = created.configOptions?.find(option => option.category === "mode")
  assert.equal(mode?.type, "select")
  if (mode?.type !== "select") assert.fail("Missing mode selection")
  assert.deepEqual(mode.options[0], { value: "default", name: "Agent", description: "Use the agent tools" })

  const changed = await connection.setConfigOption({ sessionId: created.sessionId, configId: "mode", value: "plan" })
  assert.equal(selectedMode(changed.configOptions), "plan")
  const model = await connection.setConfigOption({ sessionId: created.sessionId, configId: "model", value: "model-b" })
  assert.equal(model.configOptions.find(option => option.category === "model")?.currentValue, "model-b")
  assert.equal(selectedMode(model.configOptions), "plan")
  const update = updates.at(-1)?.update
  assert.equal(update?.sessionUpdate, "config_option_update")
  if (update?.sessionUpdate === "config_option_update") assert.equal(selectedMode(update.configOptions), "plan")
  const resumed = await connection.resume({ ...session, sessionId: created.sessionId })
  assert.equal(selectedMode(resumed.configOptions), "plan")
})

test("ACP preserves effective legacy mode updates and rejected selections", { timeout: 15_000 }, async t => {
  const updates: acp.SessionNotification[] = []
  const connection = await connectAcpProcess(launch, { onUpdate: update => { updates.push(update) } })
  t.after(() => connection.close())
  const { sessionId } = await connection.newSession(session)
  await connection.setConfigOption({ sessionId, configId: "mode", value: "plan" })
  const fallback = await connection.setConfigOption({ sessionId, configId: "mode", value: "fallback" })
  assert.equal(selectedMode(fallback.configOptions), "default")
  const update = updates.at(-1)?.update
  assert.equal(update?.sessionUpdate, "config_option_update")
  if (update?.sessionUpdate === "config_option_update") assert.equal(selectedMode(update.configOptions), "default")
  await assert.rejects(connection.setConfigOption({ sessionId, configId: "mode", value: "rejected" }))
  const unchanged = await connection.setConfigOption({ sessionId, configId: "model", value: "model-b" })
  assert.equal(selectedMode(unchanged.configOptions), "default")
})

test("ACP prefers a provider's mode config option over its standalone modes", { timeout: 15_000 }, async t => {
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_NATIVE_MODE: "true" } }, { onUpdate() {} })
  t.after(() => connection.close())
  const { sessionId, configOptions } = await connection.newSession(session)
  assert.equal(configOptions?.filter(option => option.category === "mode").length, 1)
  assert.equal(configOptions?.find(option => option.category === "mode")?.id, "native-mode")
  const changed = await connection.setConfigOption({ sessionId, configId: "native-mode", value: "plan" })
  assert.equal(selectedMode(changed.configOptions), "plan")
})

test("ACP translates unsolicited mode changes and keeps mode updates while filtering loaded history", { timeout: 15_000 }, async t => {
  const updates: acp.SessionNotification[] = []
  const connection = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_LOAD_SESSION: "true" } }, {
    onUpdate: update => { updates.push(update) },
  })
  t.after(() => connection.close())
  const { sessionId } = await connection.newSession(session)
  await connection.prompt({ sessionId, prompt: [{ type: "text", text: "Plan" }] })
  const changed = updates.at(-1)?.update
  assert.equal(changed?.sessionUpdate, "config_option_update")
  if (changed?.sessionUpdate === "config_option_update") assert.equal(selectedMode(changed.configOptions), "plan")
  updates.length = 0
  const loaded = await connection.resume({ ...session, sessionId })
  assert.equal(selectedMode(loaded.configOptions), "plan")
  assert.deepEqual(updates.map(update => update.update.sessionUpdate), ["config_option_update"])
})

test("ACP restores a saved standalone mode after a fresh process omits its resume catalog", { timeout: 15_000 }, async t => {
  const original = await connectAcpProcess(launch, { onUpdate() {} })
  t.after(() => original.close())
  const { sessionId, configOptions } = await original.newSession(session)
  const saved = await applyAgentConfiguration(original, sessionId, configOptions ?? [], { model: "model-b", mode: "plan" })
  await original.close()

  const resumed = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_OMIT_RESUME: "true" } }, { onUpdate() {} })
  t.after(() => resumed.close())
  assert.equal((await resumed.resume({ ...session, sessionId })).configOptions, undefined)
  const restored = await applyAgentConfiguration(resumed, sessionId, saved, { model: "model-b", mode: "plan" }, () => {}, true)
  assert.equal(selectedMode(restored), "plan")
  // A fresh model setter response must not make the saved mode appear confirmed.
  const confirmed = await resumed.resume({ ...session, sessionId })
  assert.equal(confirmed._meta?.currentMode, "plan")
  assert.equal(confirmed._meta?.currentModel, "model-b")
  const changed = await resumed.setConfigOption({ sessionId, configId: "mode", value: "fallback" }, restored)
  assert.equal(selectedMode(changed.configOptions), "default")
})

test("ACP restores a saved standalone mode when resume returns options without modes", { timeout: 15_000 }, async t => {
  const original = await connectAcpProcess(launch, { onUpdate() {} })
  t.after(() => original.close())
  const { sessionId, configOptions } = await original.newSession(session)
  const saved = await applyAgentConfiguration(original, sessionId, configOptions ?? [], { model: "model-b", mode: "plan" })
  await original.close()

  const resumed = await connectAcpProcess({ ...launch, env: { DESKFLEET_TEST_PARTIAL_RESUME: "true" } }, { onUpdate() {} })
  t.after(() => resumed.close())
  const partial = await resumed.resume({ ...session, sessionId })
  assert.equal(partial.configOptions?.some(option => option.category === "mode"), false)
  assert.equal(partial.configOptions?.some(option => option.category === "model"), true)
  const restored = await applyAgentConfiguration(resumed, sessionId, withRestoredSessionMode(partial.configOptions ?? [], saved), { model: "model-b", mode: "plan" })
  assert.equal(selectedMode(restored), "plan")
  const confirmed = await resumed.resume({ ...session, sessionId })
  assert.equal(confirmed._meta?.currentMode, "plan")
  assert.equal(confirmed._meta?.currentModel, "model-b")
})

test("ACP does not infer a standalone setter from an ordinary saved mode option", async () => {
  const modes = new AcpSessionModes()
  const nativeOptions: acp.SessionConfigOption[] = [{
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "plan",
    options: [{ value: "plan", name: "Plan" }],
  }]
  let nativeRequests = 0
  await modes.setConfigOption({ sessionId: "session", configId: "mode", value: "plan" },
    async () => assert.fail("A native mode option must use set_config_option"),
    async () => { nativeRequests++; return { configOptions: nativeOptions } }, nativeOptions)
  assert.equal(nativeRequests, 1)
})
