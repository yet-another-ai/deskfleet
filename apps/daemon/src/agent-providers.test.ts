import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { agentConfiguration } from "./agent-configuration-protocol.ts"
import { AgentProviders } from "./agent-providers.ts"
import { configureAdapterHost } from "./agents/adapter-host.ts"
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
  assert.deepEqual(reopened.snapshot().providers, registry.snapshot().providers)
  assert.deepEqual(reopened.snapshot().templates, registry.snapshot().templates)
  assert.notEqual(reopened.snapshot().revision, registry.snapshot().revision, "A daemon restart invalidates retained metadata")
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
  const cursor = await registry.create({ template: "cursor", name: "Cursor", env: { CURSOR_API_KEY: "secret" } })
  assert.equal(registry.resolve(cursor.id).provider.id, "cursor")
  assert.deepEqual(registry.resolve(cursor.id).config, { name: "Cursor", binaryPath: "agent", env: { CURSOR_API_KEY: "secret" } })
  const grok = await registry.create({ template: "grok", name: "Grok", env: { XAI_API_KEY: "secret" } })
  assert.equal(registry.resolve(grok.id).provider.id, "grok")
  assert.deepEqual(registry.resolve(grok.id).config, { name: "Grok", binaryPath: "grok", env: { XAI_API_KEY: "secret" } })
  const pi = await registry.create({ template: "pi", name: "Pi Coding Agent", env: { PI_CODING_AGENT_DIR: "/account/pi" } })
  assert.equal(registry.resolve(pi.id).provider.id, "pi")
  assert.deepEqual(registry.resolve(pi.id).config, { name: "Pi Coding Agent", binaryPath: "pi", env: { PI_CODING_AGENT_DIR: "/account/pi" } })
  assert.throws(() => registry.update(custom.id, { template: "codex", name: "Changed", env: {} } as AgentProviderSettings), /template is fixed/u)
  assert.equal(registry.get(custom.id).template, "acp")
  const copy = registry.get(custom.id)
  copy.env.CUSTOM = "mutated"
  assert.equal(registry.resolve(custom.id).config.env?.CUSTOM, "yes")
})

test("public provider revision changes on settings edits without exposing launch configuration", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-revision-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new AgentProviders(directory)
  await registry.init()
  const before = registry.metadata()
  assert.equal(before.revision, registry.snapshot().revision)
  assert.equal(registry.metadata().revision, before.revision, "Ordinary catalog/history refreshes keep the same revision")
  await registry.update("codex", { name: "Codex", binaryPath: "/private/tool", env: { API_KEY: "test-secret" } })
  const after = registry.metadata()
  assert.notEqual(after.revision, before.revision, "An environment-only change invalidates metadata even when its display fields are unchanged")
  assert.deepEqual(after.providers, before.providers)
  assert.equal(after.revision, registry.snapshot().revision)
  assert.match(after.revision, /^[0-9a-f-]{36}$/u)
  assert.equal(JSON.stringify(after).includes("test-secret"), false)
  assert.equal(JSON.stringify(after).includes("/private/tool"), false)
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

test("Claude Code runs its bundled adapter with the installed CLI and added variables", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-claude-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  configureAdapterHost({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))] })
  const registry = new AgentProviders(directory)
  await registry.init()
  const fallback = await registry.create({ template: "claude-code", name: "Claude Code", env: {} })
  assert.deepEqual(registry.resolve(fallback.id).config, { name: "Claude Code", binaryPath: "claude", env: {} })
  const configured = await registry.create({
    template: "claude-code", name: "Work Claude", binaryPath: "/opt/claude",
    env: { CLAUDE_CODE_EXECUTABLE: "/ignored/claude", DESKFLEET_TEST_VALUE: "work" },
  })
  const { provider, config } = registry.resolve(configured.id)
  assert.equal(provider.id, "claude-code")
  const connection = await provider.connect(config, { onUpdate() {} })
  t.after(() => connection.close())
  assert.deepEqual(connection.initialization._meta?.launch, { args: ["--claude-agent-acp"], claudeCodeExecutable: "/opt/claude" })
  assert.equal((connection.initialization._meta?.environment as { extra?: string }).extra, "work")
  await connection.close()
})

test("Cursor launches agent acp, authenticates, and continues through session/load without replaying history", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-cursor-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "cursor agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  await registry.init()
  const configured = await registry.create({
    template: "cursor", name: "Cursor", binaryPath,
    env: { DESKFLEET_TEST_AGENT_MODE: "cursor", CURSOR_API_KEY: "present" },
  })
  const { provider, config } = registry.resolve(configured.id)
  const updates: acp.SessionNotification[] = []
  const connection = await provider.connect(config, { onUpdate(update) { updates.push(update) } })
  t.after(() => connection.close())
  assert.equal(connection.initialization.agentInfo?.name, "cursor-agent")
  assert.deepEqual(connection.initialization.authMethods?.map(method => method.id), ["cursor_login"])
  assert.equal(connection.initialization.agentCapabilities?.loadSession, true)
  assert.equal(connection.initialization.agentCapabilities?.sessionCapabilities?.resume, undefined)
  assert.deepEqual((connection.initialization._meta?.launch as { args?: string[] }).args, ["acp"])
  assert.equal((connection.initialization._meta?.clientCapabilities as { _meta?: { parameterizedModelPicker?: boolean } } | undefined)?._meta?.parameterizedModelPicker, true)
  const created = await connection.newSession({ cwd: directory, mcpServers: [] })
  assert.equal(created._meta?.authenticated, true)
  const discovered = agentConfiguration(created.configOptions ?? [], { id: "cursor", name: "Cursor" })
  assert.deepEqual(discovered.reasoningEfforts?.options.map(option => option.id), ["low", "medium", "high", "xhigh"])
  const changed = await connection.setConfigOption({ sessionId: created.sessionId, configId: "effort", value: "low" }, created.configOptions ?? undefined)
  assert.equal(agentConfiguration(changed.configOptions).reasoningEfforts?.currentValue, "low")
  const loaded = await connection.resume({ cwd: directory, mcpServers: [], sessionId: created.sessionId })
  assert.equal(loaded._meta?.method, "session/load")
  assert.deepEqual(updates.map(update => update.update.sessionUpdate), ["config_option_update"])
  await connection.close()
})

test("Grok launches grok agent stdio and authenticates with xai.api_key", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-grok-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "grok agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  await registry.init()
  const configured = await registry.create({
    template: "grok", name: "Grok", binaryPath,
    env: { DESKFLEET_TEST_AGENT_MODE: "grok", XAI_API_KEY: "present" },
  })
  const { provider, config } = registry.resolve(configured.id)
  const connection = await provider.connect(config, { onUpdate() {} })
  t.after(() => connection.close())
  assert.equal(connection.initialization.agentInfo?.name, "grok")
  assert.deepEqual(connection.initialization.authMethods?.map(method => method.id), ["xai.api_key", "cached_token"])
  assert.deepEqual((connection.initialization._meta?.launch as { args?: string[] }).args, ["agent", "stdio"])
  const created = await connection.newSession({ cwd: directory, mcpServers: [] })
  assert.equal(created._meta?.authMethod, "xai.api_key")
  assert.equal(created._meta?.headless, true)
  await connection.close()
})

test("provider tests open a prompt-free session from unsaved settings and report the agent's own failure", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "fixture agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  await registry.init()
  let changes = 0
  registry.onChanged(() => { changes += 1 })
  assert.deepEqual(await registry.test({ template: "acp", name: "Fixture", binaryPath, env: {} }), { agentName: "deskfleet-test-agent" })
  await assert.rejects(
    registry.test({ template: "acp", name: "Fixture", binaryPath, env: { DESKFLEET_TEST_AGENT_MODE: "session-error" } }),
    /^Error: fixture cannot open .*df-provider-test-/u,
  )
  await assert.rejects(registry.test({ template: "acp", name: "Missing", binaryPath: join(directory, "missing"), env: {} }), /Could not start/u)
  await assert.rejects(registry.test({ template: "unknown", name: "Agent", env: {} } as never), /Unknown Agent provider template/u)
  assert.equal(changes, 0)
  assert.deepEqual(registry.snapshot().providers.map(provider => provider.id), ["codex"])
})

test("invalid provider inputs and template edits are rejected by the IPC boundary", () => {
  for (const method of ["providerProbe", "providerInstall", "providerLogin"] as const) {
    assert.throws(() => validateControlParams(method, { provider: { template: "unknown", name: "Agent", env: {} } }), /Unknown Agent provider template/u)
    assert.throws(() => validateControlParams(method, { provider: { template: "codex", name: "Agent", binaryPath: "bad\0path", env: {} } }), /binary path/u)
  }
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "unknown", name: "Agent", env: {} } }), /Unknown Agent provider template/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: " ", env: {} } }), /Provider names/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", binaryPath: "bad\0path", env: {} } }), /binary path/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", env: { "BAD=KEY": "yes" } } }), /variable name/u)
  assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", env: { TOKEN: 12 } } }), /values must be strings/u)
  assert.throws(() => validateControlParams("providerUpdate", { providerId: "codex", changes: { template: "acp", name: "Agent", env: {} } }), /template is fixed/u)
  assert.throws(() => validateControlParams("providerRemove", { providerId: "../codex" }), /provider ID/u)
  assert.throws(() => validateControlParams("providerTest", { provider: { template: "unknown", name: "Agent", env: {} } }), /Unknown Agent provider template/u)
  assert.throws(() => validateControlParams("providerTest", { provider: { template: "acp", name: "Agent", binaryPath: "bad\0path", env: {} } }), /binary path/u)
  for (const icon of ["", "../openai", "https://example.com/icon.svg", "OpenAI", "bad--slug", "a".repeat(81), 12]) {
    assert.throws(() => validateControlParams("providerCreate", { provider: { template: "codex", name: "Agent", icon, env: {} } }), /provider icon/u)
    assert.throws(() => validateControlParams("providerUpdate", { providerId: "codex", changes: { name: "Agent", icon, env: {} } }), /provider icon/u)
  }
})

test("connection tests never request Cursor login, including when cached credentials expire", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-auth-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "cursor agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  const provider = { template: "cursor" as const, name: "Cursor", binaryPath, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-test" } }
  assert.deepEqual(await registry.test(provider), { agentName: "cursor-agent" })
  await assert.rejects(registry.test({ ...provider, env: { DESKFLEET_TEST_AGENT_MODE: "cursor-test-signed-out" } }), /Use the Log in button/u)
})

test("Codex connection tests disable the bridge's automatic login setting", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-codex-auth-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  configureAdapterHost({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))] })
  const registry = new AgentProviders(directory)
  assert.deepEqual(await registry.test({ template: "codex", name: "Codex", env: {
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "chatgpt" }), DESKFLEET_TEST_AGENT_MODE: "test-no-login",
  } }), { agentName: "deskfleet-test-agent" })
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
