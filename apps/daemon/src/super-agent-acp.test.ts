import assert from "node:assert/strict"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { AgentProviders } from "./agent-providers.ts"
import { getDaemonAgentProvider } from "./agents/registry.ts"
import { createCoordinatorRuntime } from "./super-agent-provider.ts"

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-test-routing-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const windows = process.platform === "win32"
  const binaryPath = join(directory, windows ? "agent.cmd" : "agent")
  await writeFile(binaryPath, windows ? '@"%TEST_NODE%" "%TEST_ROUTER%" %*\r\n'
    : '#!/bin/sh\nexec "$TEST_NODE" "$TEST_ROUTER" "$@"\n', { mode: 0o700 })
  const registry = new AgentProviders(directory, getDaemonAgentProvider("acp"))
  await registry.init()
  const env = { TEST_NODE: process.execPath, TEST_ROUTER: fileURLToPath(new URL("./fixtures/acp-routing-agent.ts", import.meta.url)) }
  const runtime = createCoordinatorRuntime(registry)
  t.after(() => runtime.close())
  return { registry, runtime, settings: { inheritShellEnvironment: false, binaryPath, env } }
}

test("the same ACP registration serves discovery and decisions with its own selected model, effort and credentials", async t => {
  const { registry, runtime, settings } = await setup(t)
  for (const template of ["acp", "antigravity", "codebuddy", "cursor", "grok", "omp", "deepseek-harness"] as const) {
    const env = { ...settings.env, TEST_ROUTER_INSTANCE: template }
    const { id } = await registry.create({ ...settings, name: template, template, env })
    const options = await runtime.options(id, "deep")
    assert.deepEqual(options.models.map(m => [m.id, m.reasoningEfforts]), [["quick", ["low"]], ["deep", ["medium", "high"]]], template)
    let used: number | undefined
    const value = await runtime.model(id)({ message: template }, undefined, [{ type: "image", mimeType: "image/png", data: "aQ==" }], {
      selection: { model: "deep", reasoningEffort: "high" }, onUsage: usage => { used = usage?.used },
    })
    assert.partialDeepStrictEqual(value, { model: "deep", effort: "high", account: template, image: true,
      packet: { message: template }, capabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      denied: { outcome: { outcome: "cancelled" } }, fileDenied: true, sameDirectory: true, mcp: [], instructions: "override" })
    assert.equal(used, 25)
    const { cwd, profile } = value as { cwd: string; profile?: string }
    await assert.rejects(stat(cwd), { code: "ENOENT" })
    if (template === "antigravity") assert.match(profile!, /tools: \[\]\nmcpServers: \[\]/)
    if (template === "deepseek-harness") assert.partialDeepStrictEqual(value, { args: ["--profile", "acp"] })
  }
})

test("an ACP coordinator rejects invalid selections, execution tools and malformed replies, and can be stopped", async t => {
  const { registry, runtime, settings } = await setup(t)
  const { id } = await registry.create({ ...settings, name: "Custom", template: "acp" })
  const model = runtime.model(id)
  await assert.rejects(model({}, undefined, undefined, { selection: { model: "deep", reasoningEffort: "low" } }), /Unsupported agent reasoning_effort/)
  await assert.rejects(model({ invalid: true }), /JSON decision/)
  await assert.rejects(model({ tool: true }), /tool|closed/i)
  await assert.rejects(model({ stall: true }, AbortSignal.timeout(500)))
  await registry.remove(id)
  await assert.rejects(model({}), /unavailable/)
})

test("a registered Codex model outside the native catalog uses the same account over ACP", async t => {
  const { registry, runtime, settings } = await setup(t)
  const { id } = await registry.create({ ...settings, name: "Toolchain", template: "codex",
    env: { ...settings.env, TEST_ROUTER_INSTANCE: "toolchain", OPENAI_BASE_URL: "", CODEX_API_KEY: "", OPENAI_API_KEY: "" } })
  const options = await runtime.options(id, "deep")
  assert.deepEqual(options.models.map(m => m.id), ["quick", "deep"])
  const decision = await runtime.model(id)({ message: "use the registered model" }, undefined, undefined, { selection: { model: "deep", reasoningEffort: "high" } })
  assert.partialDeepStrictEqual(decision, { account: "toolchain", model: "deep", effort: "high" })
})
