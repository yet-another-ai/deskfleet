import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { runAgent } from "./agent-cli.ts"
import { AgentProviders } from "./agent-providers.ts"

test("Oh My Pi launches native ACP from provider settings and the agent CLI", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-omp-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binaryPath = join(directory, "omp agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  const registry = new AgentProviders(directory)
  await registry.init()
  const input = { template: "omp" as const, name: "Work OMP", binaryPath, env: { DESKFLEET_TEST_VALUE: "work" } }
  const configured = await registry.create(input)
  const reopened = new AgentProviders(directory)
  await reopened.init()
  const { provider, config } = reopened.resolve(configured.id)
  const connection = await provider.connect(config, { onUpdate() {} })
  t.after(() => connection.close())
  assert.deepEqual((connection.initialization._meta?.launch as { args?: string[] }).args, ["acp"])
  assert.equal((connection.initialization._meta?.environment as { extra?: string }).extra, "work")
  const request = { cwd: directory, mcpServers: [{ name: "tools", command: "example-mcp", args: [], env: [] }] }
  const created = await connection.newSession(request)
  assert.ok(created.sessionId)
  assert.deepEqual(created._meta?.request, request)
  await connection.close()
  assert.deepEqual(await registry.test(input), { agentName: "deskfleet-test-agent" })

  const output: string[] = []
  t.mock.method(console, "log", (line: string) => output.push(line))
  await runAgent(["omp", "--check", "--binary-path", binaryPath, "--env", "DESKFLEET_TEST_VALUE=cli"])
  const initialized = JSON.parse(output[0]!)
  assert.equal(initialized.event, "initialized")
  assert.equal(initialized.provider, "omp")
  assert.equal(initialized.name, "Oh My Pi")
  assert.deepEqual(initialized._meta.launch.args, ["acp"])
  assert.equal(initialized._meta.environment.extra, "cli")
})
