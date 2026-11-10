import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { runAgent } from "./agent-cli.ts"
import { AgentProviders } from "./agent-providers.ts"
import { codebuddyProcess } from "./agents/codebuddy.ts"
import { launchProviderCommand } from "./provider-setup-process.ts"

test("CodeBuddy uses native ACP with the selected workspace and environment", () => {
  const env = { CODEBUDDY_API_KEY: "fixture-key", CODEBUDDY_INTERNET_ENVIRONMENT: "internal" }
  assert.deepEqual(codebuddyProcess({ name: "CodeBuddy" }), { command: "codebuddy", args: ["--acp"], env: {} })
  for (const binaryPath of ["/opt/Agent Tools/codebuddy", "C:\\Agent Tools\\codebuddy.exe", "C:\\Agent Tools\\codebuddy.cmd"]) {
    assert.deepEqual(codebuddyProcess({ name: "Work", binaryPath, env, cwd: process.cwd() }), {
      ...launchProviderCommand(binaryPath, ["--acp"], env), cwd: process.cwd(),
    })
  }
})

test("CodeBuddy provider settings survive restart and keep credentials out of public metadata", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-codebuddy-settings-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new AgentProviders(directory)
  await registry.init()
  const input = {
    template: "codebuddy" as const, name: "Work CodeBuddy", inheritShellEnvironment: false,
    env: { CODEBUDDY_API_KEY: "fixture-secret", CODEBUDDY_INTERNET_ENVIRONMENT: "internal" },
  }
  const created = await registry.create(input)
  const reopened = new AgentProviders(directory)
  await reopened.init()
  assert.deepEqual(reopened.get(created.id), created)
  assert.deepEqual(reopened.snapshot().templates.find(template => template.id === "codebuddy"), {
    id: "codebuddy", name: "CodeBuddy Code", defaultBinaryPath: "codebuddy",
  })
  const resolved = reopened.resolve(created.id)
  assert.equal(resolved.provider.id, "codebuddy")
  assert.deepEqual(resolved.config, { name: input.name, binaryPath: "codebuddy", env: input.env })
  assert.deepEqual(reopened.metadata().providers, [{ id: created.id, name: input.name, template: "codebuddy" }])
})

test("CodeBuddy connects from saved settings and the CLI without requesting interactive authentication", {
  timeout: 20_000,
}, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "df-provider-codebuddy-")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "codebuddy agent.exe")
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  const spawn = childProcess.spawn
  // Substitute only this executable at the OS boundary. The provider, stdio
  // transport, working directory, and ACP authentication lifecycle stay real.
  t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: childProcess.SpawnOptions) =>
    command === binaryPath ? spawn(process.execPath, [fixture, ...args], options) : spawn(command, args, options)
  ) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const registry = new AgentProviders(directory)
  await registry.init()
  const input = {
    template: "codebuddy" as const, name: "Work CodeBuddy", binaryPath, inheritShellEnvironment: false,
    env: { DESKFLEET_TEST_AGENT_MODE: "codebuddy", DESKFLEET_TEST_VALUE: "work" },
  }
  const configured = await registry.create(input)
  const { provider, config } = registry.resolve(configured.id)
  const connection = await provider.connect({ ...config, cwd: directory }, { onUpdate() {}, signal: t.signal })
  t.after(() => connection.close())
  assert.deepEqual(connection.initialization._meta?.launch, { args: ["--acp"], cwd: directory })
  assert.equal((connection.initialization._meta?.environment as { extra?: string }).extra, "work")
  const request = { cwd: directory, mcpServers: [{ name: "tools", command: "example-mcp", args: [], env: [] }] }
  const session = await connection.newSession(request)
  assert.deepEqual(session._meta?.request, request)
  await connection.close()
  assert.deepEqual(await registry.test(input), { agentName: "deskfleet-test-agent" })
  await assert.rejects(registry.test({ ...input, env: { DESKFLEET_TEST_AGENT_MODE: "codebuddy-signed-out" } }), /Use the Log in button/u)

  const output: string[] = []
  t.mock.method(console, "log", (line: string) => output.push(line))
  await runAgent(["codebuddy", "--check", "--binary-path", binaryPath, "--cwd", directory, "--env", "DESKFLEET_TEST_AGENT_MODE=codebuddy"])
  const initialized = JSON.parse(output[0]!)
  assert.equal(initialized.event, "initialized")
  assert.equal(initialized.provider, "codebuddy")
  assert.equal(initialized.name, "CodeBuddy Code")
  assert.deepEqual(initialized._meta.launch, { args: ["--acp"], cwd: directory })
})
