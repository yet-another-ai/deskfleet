import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { AgentProviders } from "./agent-providers.ts"
import { validateControlParams } from "./control-request.ts"
import type { AgentProviderSettings } from "./provider-protocol.ts"

test("provider settings persist with private permissions and removal preserves an empty registry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-providers-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new AgentProviders(directory)
  await registry.init()
  assert.deepEqual(registry.snapshot().providers, [{ id: "codex", template: "codex", name: "Codex", env: {} }])
  let changes = 0
  registry.onChanged(() => { changes += 1 })
  const first = await registry.create({ template: "codex", name: " Work Codex ", binaryPath: "  ", env: { API_KEY: "secret", EMPTY: "" } })
  const second = await registry.create({ template: "acp", name: "Custom agent", binaryPath: "/opt/custom agent", env: {} })
  assert.equal(first.name, "Work Codex")
  assert.equal(first.binaryPath, undefined)
  const updated = await registry.update(first.id, { name: "Renamed", binaryPath: "/opt/codex", env: { MODE: "work" } })
  assert.equal(updated.template, "codex")
  assert.deepEqual(registry.resolve(first.id).config, { name: "Renamed", binaryPath: "/opt/codex", env: { MODE: "work" } })
  const reopened = new AgentProviders(directory)
  await reopened.init()
  assert.deepEqual(reopened.snapshot(), registry.snapshot())
  const path = join(directory, "agent-providers.json")
  assert.ok(!(await readFile(path, "utf8")).includes("secret"))
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
  await Promise.all([registry.remove("codex"), registry.remove(first.id), registry.remove(second.id)])
  assert.equal(changes, 6)
  await reopened.init()
  assert.deepEqual(reopened.snapshot().providers, [])
  assert.throws(() => registry.resolve(first.id), /unavailable/u)
})

test("templates resolve their own binary defaults and cannot change after creation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-providers-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = { id: "fixture", connect: async () => { throw new Error("fixture") } }
  const registry = new AgentProviders(directory, fixture)
  await registry.init()
  assert.equal(registry.resolve("codex").provider, fixture)
  assert.equal(registry.resolve("codex").config.binaryPath, "codex")
  const custom = await registry.create({ template: "acp", name: "Local ACP", env: { CUSTOM: "yes" } })
  assert.equal(registry.resolve(custom.id).provider.id, "acp")
  assert.deepEqual(registry.resolve(custom.id).config, { name: "Local ACP", binaryPath: "acp-agent", env: { CUSTOM: "yes" } })
  assert.throws(() => registry.update(custom.id, { template: "codex", name: "Changed", env: {} } as AgentProviderSettings), /template is fixed/u)
  assert.equal(registry.get(custom.id).template, "acp")
  const copy = registry.get(custom.id)
  copy.env.CUSTOM = "mutated"
  assert.equal(registry.resolve(custom.id).config.env?.CUSTOM, "yes")
})

test("provider icons persist, remain editable, and can return to the template default", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-icons-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new AgentProviders(directory)
  await registry.init()
  const created = await registry.create({ template: "codex", name: "Work", icon: "openai", env: {} })
  const reopened = new AgentProviders(directory)
  await reopened.init()
  assert.equal(reopened.get(created.id).icon, "openai")
  const launch = registry.resolve(created.id)
  await registry.update(created.id, { name: "Work", icon: "deepseek", env: {} })
  await reopened.init()
  assert.equal(reopened.get(created.id).icon, "deepseek")
  assert.deepEqual(registry.resolve(created.id), launch, "Icon selection does not change process launch settings")
  await registry.update(created.id, { name: "Work", env: {} })
  await reopened.init()
  assert.equal(reopened.get(created.id).icon, undefined)
})

test("generic ACP launches the configured binary with added variables and inherited environment", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-launch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "custom acp agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  await registry.init()
  const configured = await registry.create({
    template: "acp", name: "Fixture ACP", binaryPath,
    env: {
      LANG: "deskfleet-provider-test", DESKFLEET_TEST_VALUE: "provider override",
    },
  })
  const { provider, config } = registry.resolve(configured.id)
  const connection = await provider.connect(config, { onUpdate() {} })
  t.after(() => connection.close())
  assert.equal(connection.initialization.agentInfo?.name, "deskfleet-test-agent")
  assert.deepEqual(connection.initialization._meta?.environment, {
    PATH: process.env.PATH, LANG: "deskfleet-provider-test", extra: "provider override",
  })
  await connection.close()
})

test("invalid provider inputs and template edits are rejected by the IPC boundary", () => {
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "unknown", name: "Agent", env: {} } }), /Unknown Agent provider template/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: " ", env: {} } }), /Provider names/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", binaryPath: "bad\0path", env: {} } }), /binary path/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", env: { "BAD=KEY": "yes" } } }), /variable name/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", env: { TOKEN: 12 } } }), /values must be strings/u)
  assert.throws(() => validateControlParams("providerUpdate", { providerId: "codex", changes: { template: "acp", name: "Agent", env: {} } }), /template is fixed/u)
  assert.throws(() => validateControlParams("providerRemove", { providerId: "../codex" }), /provider ID/u)
  for (const icon of ["", "../openai", "https://example.com/icon.svg", "OpenAI", "bad--slug", "a".repeat(81), 12]) {
    assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", icon, env: {} } }), /provider icon/u)
    assert.throws(() => validateControlParams("providerUpdate", { providerId: "codex", changes: { name: "Agent", icon, env: {} } }), /provider icon/u)
  }
})

test("invalid persisted settings do not silently reset the user's providers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-providers-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "agent-providers.json")
  const invalid = JSON.stringify({ providers: [{ id: "custom", template: "unknown", name: "Agent", env: {} }] })
  await writeFile(path, invalid)
  await assert.rejects(new AgentProviders(directory).init(), /Unknown Agent provider template/u)
  assert.equal(await readFile(path, "utf8"), invalid)
})
