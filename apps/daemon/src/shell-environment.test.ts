import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TerminalSessions } from "./terminals.ts"
import { AcpTerminals } from "./agents/terminals.ts"
import { AgentProviders } from "./agent-providers.ts"
import { loadShellEnvironment } from "./shell-environment.ts"

test("shell exports supplement the daemon environment and provider values override them", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-shell-env-"))
  const shell = join(directory, "shell")
  await writeFile(shell, "#!/bin/sh\nprintf 'startup output\\n'\nexport SHELL_ONLY='line 1\nline=2'\nexport OVERRIDE=shell\nexport PATH=/shell/bin\nexec /bin/sh -c \"$2\"\n", { mode: 0o755 })
  const previous = process.env.SHELL
  process.env.SHELL = shell
  t.after(async () => {
    if (previous === undefined) delete process.env.SHELL
    else process.env.SHELL = previous
    await rm(directory, { recursive: true, force: true })
  })
  const loaded = await loadShellEnvironment(shell)
  assert.equal(loaded.SHELL_ONLY, "line 1\nline=2")
  const registry = new AgentProviders(directory, {
    id: "fixture",
    async connect(config) {
      assert.equal(config.env?.SHELL_ONLY, "line 1\nline=2")
      assert.equal(config.env?.OVERRIDE, "manual")
      assert.equal(config.env?.ADDED, "manual-only")
      assert.equal(config.env?.PATH, "/bundled:/shell/bin")
      throw new Error("fixture connected")
    },
  }, "/bundled")
  await registry.init()
  const record = await registry.create({ template: "codex", name: "Fixture", env: { OVERRIDE: "manual", ADDED: "manual-only" } })
  const { provider, config } = registry.resolve(record.id)
  await assert.rejects(provider.connect(config, { onUpdate() {} }), /fixture connected/u)
  const reopened = new AgentProviders(directory)
  await reopened.init()
  assert.equal(reopened.get(record.id).inheritShellEnvironment, undefined)
  await reopened.update(record.id, { name: "Fixture", inheritShellEnvironment: false, env: {} })
  const disabled = new AgentProviders(directory)
  await disabled.init()
  assert.equal(disabled.get(record.id).inheritShellEnvironment, false)
  await reopened.update(record.id, { name: "Fixture", env: {} })
  assert.equal(reopened.get(record.id).inheritShellEnvironment, undefined)
})

test("shell-enabled ACP terminals receive provider variables and respect command overrides", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-shell-terminal-"))
  const shell = join(directory, "shell")
  await writeFile(shell, '#!/bin/sh\nexport PATH=/shell/bin SHELL_ONLY=shell OVERRIDE=shell\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
  const previous = process.env.SHELL
  process.env.SHELL = shell
  t.after(async () => {
    if (previous === undefined) delete process.env.SHELL
    else process.env.SHELL = previous
    await rm(directory, { recursive: true, force: true })
  })
  for (const commandDirectory of [undefined, "/bundled"]) {
    const launched: Array<{ env?: Record<string, string> }> = []
    const sessions = {
      async run(options: { env?: Record<string, string> }) { launched.push(options); return {} },
      async stop() {},
    } as unknown as TerminalSessions
    const registry = new AgentProviders(join(directory, commandDirectory ? "bundled" : "plain"), {
      id: "fixture",
      async connect(config, client) {
        assert.ok(client.terminals)
        const terminals = new AcpTerminals(client.terminals, () => {})
        await terminals.create({ sessionId: "session", command: "example" })
        await terminals.create({ sessionId: "session", command: "example", env: [
          { name: "PATH", value: "/command/bin" }, { name: "OVERRIDE", value: "command" },
        ] })
        await terminals.close()
        assert.equal(launched[0]?.env?.PATH, commandDirectory ? "/bundled:/shell/bin" : "/shell/bin")
        assert.equal(launched[0]?.env?.SHELL_ONLY, "shell")
        assert.equal(launched[0]?.env?.OVERRIDE, "manual")
        assert.equal(launched[1]?.env?.PATH, commandDirectory ? "/bundled:/command/bin" : "/command/bin")
        assert.equal(launched[1]?.env?.OVERRIDE, "command")
        assert.equal(launched[1]?.env?.SHELL_ONLY, "shell")
        assert.equal(config.env?.OVERRIDE, "manual")
        throw new Error("fixture connected")
      },
    }, commandDirectory)
    await registry.init()
    const record = await registry.create({ template: "codex", name: "Fixture", inheritShellEnvironment: true, env: { OVERRIDE: "manual" } })
    const { provider, config } = registry.resolve(record.id)
    await assert.rejects(provider.connect(config, { onUpdate() {}, terminals: { sessions, cwd: directory, commandDirectory } }), /fixture connected/u)
  }
})

test("shell failures keep startup output private and cancellation interrupts loading", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-shell-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const failure = join(directory, "failure")
  await writeFile(failure, "#!/bin/sh\necho secret-value >&2\nexit 1\n", { mode: 0o755 })
  await assert.rejects(loadShellEnvironment(failure), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Could not load/u)
    assert.equal(error.cause, undefined)
    return true
  })
  const stalled = join(directory, "stalled")
  await writeFile(stalled, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 })
  const controller = new AbortController()
  const loading = loadShellEnvironment(stalled, controller.signal)
  controller.abort(new Error("cancelled by caller"))
  await assert.rejects(loading, /cancelled by caller/u)
})
