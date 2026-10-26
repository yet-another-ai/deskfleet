import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { agentConfiguration } from "./agent-configuration-protocol.ts"
import { AgentProviders } from "./agent-providers.ts"
import type { AgentConnection } from "./agents/acp.ts"
import { configureAdapterHost } from "./agents/adapter-host.ts"

async function fixture(t: TestContext, auth = "configured") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "df-provider-pi-")))
  const connections: AgentConnection[] = []
  const logPath = join(directory, "pi-rpc.jsonl")
  async function log(): Promise<Array<Record<string, unknown>>> {
    return (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  }
  t.after(async () => {
    await Promise.all(connections.map(connection => connection.close()))
    const events = await log().catch(() => [])
    for (const event of events) {
      if (event.type !== "launch" || typeof event.pid !== "number" || events.some(value => value.type === "exit" && value.pid === event.pid)) continue
      try { process.kill(event.pid, "SIGKILL") } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    await rm(directory, { recursive: true, force: true })
  })
  const cwd = join(directory, "workspace")
  const agentDirectory = join(directory, "pi-agent")
  const privateHome = join(directory, "home")
  const emptyPath = join(directory, "bin")
  await Promise.all([cwd, agentDirectory, privateHome, emptyPath].map(path => mkdir(path)))
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ quietStartup: true }))
  const binaryPath = join(directory, "custom pi agent")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const script = fileURLToPath(new URL("./fixtures/pi-rpc-agent.ts", import.meta.url))
  await writeFile(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 })
  configureAdapterHost({ command: process.execPath, args: [fileURLToPath(new URL("./main.ts", import.meta.url))] })
  const registry = new AgentProviders(directory)
  await registry.init()
  const configured = await registry.create({
    template: "pi", name: "Work Pi", binaryPath,
    env: {
      // pi-acp's session map uses os.homedir(), independently of Pi's own agent directory.
      HOME: privateHome, PI_CODING_AGENT_DIR: agentDirectory, PATH: emptyPath,
      PI_ACP_PI_COMMAND: "/ignored/pi", DESKFLEET_TEST_VALUE: "provider environment",
      DESKFLEET_TEST_PI_LOG: logPath, DESKFLEET_TEST_PI_AUTH: auth,
    },
  })
  const { provider, config } = registry.resolve(configured.id)
  assert.equal(provider.id, "pi")
  return {
    cwd, binaryPath, agentDirectory, env: config.env,
    async connect(updates: acp.SessionNotification[] = []) {
      const connection = await provider.connect(config, { onUpdate(update) { updates.push(update) } })
      connections.push(connection)
      return connection
    },
    log,
    async exited(pid: number): Promise<void> {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        if ((await log()).some(entry => entry.type === "exit" && entry.pid === pid && entry.signal === "SIGTERM")) return
        await delay(20)
      }
      assert.fail("Closing the ACP connection must dispose its Pi CLI subprocess")
    },
  }
}

test("Pi runs the bundled ACP bridge with its configured CLI and continues saved sessions", { timeout: 20_000, skip: process.platform === "win32" }, async t => {
  const pi = await fixture(t)
  const updates: acp.SessionNotification[] = []
  const connection = await pi.connect(updates)
  assert.equal(connection.initialization.agentInfo?.name, "pi-acp")
  assert.equal(connection.initialization.agentInfo?.version, "0.0.34")
  assert.equal(connection.initialization.agentCapabilities?.loadSession, true)
  const created = await connection.newSession({ cwd: pi.cwd, mcpServers: [] })
  const configuration = agentConfiguration(created.configOptions ?? [], { id: "pi", name: "Work Pi" })
  assert.equal(configuration.models?.currentValue, "fixture/first")
  assert.deepEqual(configuration.models?.options.map(option => option.id), ["fixture/first", "fixture/second"])
  assert.equal(configuration.reasoningEfforts?.id, "thought_level")
  assert.equal(configuration.reasoningEfforts.currentValue, "medium")
  assert.deepEqual(configuration.reasoningEfforts.options.map(option => option.id), ["off", "low", "medium", "high"])
  assert.equal(configuration.modes, null, "Pi's legacy modes mirror thought_level, rather than a second mode control")
  const launched = (await pi.log()).find(entry => entry.type === "launch")!
  assert.equal(typeof launched.pid, "number")
  assert.deepEqual(launched, {
    type: "launch", pid: launched.pid, args: ["--mode", "rpc", "--no-themes"], cwd: pi.cwd,
    extra: "provider environment", piCommand: pi.binaryPath,
  })

  const changedModel = await connection.setConfigOption({ sessionId: created.sessionId, configId: "model", value: "fixture/second" }, created.configOptions ?? undefined)
  assert.equal(agentConfiguration(changedModel.configOptions).models?.currentValue, "fixture/second")
  const changedThought = await connection.setConfigOption({ sessionId: created.sessionId, configId: "thought_level", value: "high" }, changedModel.configOptions)
  assert.equal(agentConfiguration(changedThought.configOptions).reasoningEfforts?.currentValue, "high")
  assert.equal(agentConfiguration(changedThought.configOptions).modes, null)

  assert.equal((await connection.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "Check the workspace" }] })).stopReason, "end_turn")
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Pi fixture answer"))
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text" && update.content.text === "Pi fixture thought"))
  assert.ok((await pi.log()).some(entry => entry.type === "prompt" && entry.message === "Check the workspace"))
  await connection.close()
  await pi.exited(launched.pid as number)

  const resumedUpdates: acp.SessionNotification[] = []
  const resumed = await pi.connect(resumedUpdates)
  const loaded = await resumed.resume({ sessionId: created.sessionId, cwd: pi.cwd, mcpServers: [] })
  const restored = agentConfiguration(loaded.configOptions ?? [])
  assert.equal(restored.models?.currentValue, "fixture/second")
  assert.equal(restored.reasoningEfforts?.currentValue, "high")
  assert.equal(restored.modes, null)
  assert.ok((await pi.log()).some(entry => entry.type === "get_messages"), "session/load requests saved history from Pi")
  assert.equal(resumedUpdates.some(({ update }) => update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk"), false, "deskfleet already owns the conversation and suppresses ACP history replay")
  const launches = (await pi.log()).filter(entry => entry.type === "launch")
  assert.equal(launches.length, 2)
  assert.deepEqual(launches[1]!.args, ["--mode", "rpc", "--no-themes", "--session", join(pi.agentDirectory, "fixture-session.json")])
  assert.equal((await resumed.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "Continue" }] })).stopReason, "end_turn")
  assert.ok(resumedUpdates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Pi fixture answer"), "new output is delivered after replay suppression ends")
  await resumed.close()
  await pi.exited(launches[1]!.pid as number)
})

test("Pi disposes its CLI when ACP output closes before input", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const pi = await fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url)), "--pi-acp"], {
    env: { ...process.env, ...pi.env, PI_ACP_PI_COMMAND: pi.binaryPath },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const exited = once(child, "close")
  const lines = createInterface({ input: child.stdout })
  t.after(async () => {
    lines.close()
    child.kill("SIGKILL")
    await exited
  })
  let nextId = 0
  const request = async (method: string, params: unknown) => {
    const id = ++nextId
    const stopped = exited.then(() => { throw new Error("Pi adapter exited before replying") })
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const received = (line: string) => {
        const message = JSON.parse(line)
        if (message.id !== id) return
        lines.off("line", received)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
      lines.on("line", received)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return Promise.race([response, stopped])
  }
  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} })
    const commandsUpdated = new Promise<void>(resolve => {
      const received = (line: string) => {
        const message = JSON.parse(line)
        if (message.method !== "session/update" || message.params.update.sessionUpdate !== "available_commands_update") return
        lines.off("line", received)
        resolve()
      }
      lines.on("line", received)
    })
    await request("session/new", { cwd: pi.cwd, mcpServers: [] })
    await commandsUpdated
    const launched = (await pi.log()).find(entry => entry.type === "launch")!
    // Reproduce the close ordering without a race: the response pipe has gone
    // away, but EOF cannot trigger the adapter's stdin shutdown handler yet.
    child.stdout.destroy()
    await once(child.stdout, "close")
    // An unknown method makes the adapter write an error response without
    // making the CLI itself write into a pipe while it is being disposed.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "deskfleet/test_closed_output", params: {} })}\n`)
    const [code, signal] = await exited
    assert.equal(code, 0)
    assert.equal(signal, null)
    await pi.exited(launched.pid as number)
  } finally {
    lines.close()
    child.kill("SIGKILL")
    await exited
  }
})

test("Pi reports authentication required when its CLI has no configured models", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const pi = await fixture(t, "missing")
  const connection = await pi.connect()
  await assert.rejects(connection.newSession({ cwd: pi.cwd, mcpServers: [] }), error => {
    assert.equal((error as { code?: number }).code, -32000)
    assert.match((error as Error).message, /API key|OAuth|Authentication required/u)
    return true
  })
  assert.equal((await pi.log()).some(entry => entry.type === "prompt"), false)
})
