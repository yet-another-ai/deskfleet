import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { build } from "esbuild"
import { startDaemon } from "../../daemon/src/daemon.ts"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "../../daemon/src/agents/acp.ts"
import type { AgentSmokeContext, AgentSmokeResult } from "./fixtures/agent-main.ts"

type PromptResponse = Awaited<ReturnType<AgentConnection["prompt"]>>
type ConfigOptions = NonNullable<Awaited<ReturnType<AgentConnection["newSession"]>>["configOptions"]>

const execute = promisify(execFile)
const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-agent-smoke-")))
const executable = createRequire(import.meta.url)("electron") as string
const controlDirectory = join(directory, "daemon")
const repository = join(directory, "repository")
const rendererDirectory = resolve(import.meta.dirname, "../out/renderer")
const preloadPath = join(directory, "local-preload.cjs")
const screenshotPath = join(tmpdir(), `deskfleet-agent-smoke-${process.pid}.png`)
const questionScreenshotPath = join(tmpdir(), `deskfleet-agent-question-${process.pid}.png`)
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
let electron: ChildProcess | undefined
let exited: Promise<void> | undefined
let diagnostics = ""
let clientNumber = 0

/** Deterministic provider behavior, with no external agent process or credentials. */
class ScriptedProvider implements AgentProvider {
  readonly id = "codex"
  readonly prompts: string[] = []
  readonly steers: string[] = []
  readonly promptConfigurations: { model: string; reasoningEffort: string; launch: AgentConfig }[] = []
  readonly connectionConfigurations: AgentConfig[] = []
  readonly failures: unknown[] = []
  connections = 0

  async connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection> {
    this.connections++
    this.connectionConfigurations.push(structuredClone(config))
    let model = "balanced"
    let reasoningEffort = "medium"
    let active: ((result: PromptResponse) => void) | undefined
    const configuration = (): ConfigOptions => [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "balanced", name: "Smoke Balanced" }, { value: "fast", name: "Smoke Fast" }] },
      { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: reasoningEffort, options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    ]
    const update = (text: string) => client.onUpdate({ sessionId: "smoke-provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } })
    const finish = () => { const done = active; active = undefined; done?.({ stopReason: "end_turn" }) }
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {} } }, _meta: { steering: { supported: true, supportsPromptRequired: true } } },
      newSession: async () => ({ sessionId: "smoke-provider-session", configOptions: configuration() }),
      resume: async () => ({ configOptions: configuration() }),
      setConfigOption: async params => {
        assert.ok(typeof params.value === "string")
        if (params.configId === "model") {
          assert.ok(["balanced", "fast"].includes(params.value))
          model = params.value
          reasoningEffort = "medium"
        } else {
          assert.equal(params.configId, "reasoning_effort")
          assert.ok(["medium", "high"].includes(params.value))
          reasoningEffort = params.value
        }
        const configOptions = configuration()
        await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions } })
        return { configOptions }
      },
      prompt: async params => {
        const text = params.prompt.map(block => block.type === "text" ? block.text : "").join("")
        this.prompts.push(text)
        this.promptConfigurations.push({ model, reasoningEffort, launch: structuredClone(config) })
        if (text === "Smoke first prompt") {
          const done = new Promise<PromptResponse>(resolve => { active = resolve })
          await update("stream one 中文\n")
          await delay(75)
          await update("stream two\n")
          return done
        }
        assert.ok(["Smoke queued candidate", "Smoke changed model prompt"].includes(text), "Only the untouched candidate or explicit new prompt should run")
        await update(text === "Smoke queued candidate" ? "queued reply\n" : "changed model reply\n")
        return { stopReason: "end_turn" }
      },
      steer: async params => {
        const text = params.prompt.map(block => block.type === "text" ? block.text : "").join("")
        assert.equal(text, "Smoke selected steer")
        this.steers.push(text)
        await update("steer received\n")
        void (async () => {
          assert.ok(client.requestPermission)
          const response = await client.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: "smoke-edit", title: "Write smoke fixture", kind: "edit", status: "pending" },
            options: [{ optionId: "allow", name: "Allow smoke edit", kind: "allow_once" }, { optionId: "deny", name: "Reject smoke edit", kind: "reject_once" }],
          }, new AbortController().signal)
          assert.deepEqual(response.outcome, { outcome: "selected", optionId: "allow" })
          await update("permission accepted\n")
          assert.ok(client.requestElicitation)
          const answer = await client.requestElicitation({
            sessionId: params.sessionId, toolCallId: "smoke-question", mode: "form", message: "Choose how to implement the interface.",
            requestedSchema: {
              type: "object", required: ["approach", "details"], properties: {
                approach: { type: "string", title: "Which interface should we build?", description: "Implementation approach", oneOf: [
                  { const: "Inline form", title: "Inline form", description: "Keep questions inside the conversation." },
                  { const: "Dialog", title: "Dialog", description: "Open questions in a separate dialog." },
                ] },
                details: { type: "string", title: "Anything else to include?" },
              },
            },
          }, new AbortController().signal)
          assert.deepEqual(answer, { action: "accept", content: { approach: "Inline form", details: "Support keyboard navigation." } })
          await update("question answered\n")
          finish()
        })().catch(error => { this.failures.push(error); finish() })
        return { outcome: "injected" }
      },
      cancel: async () => finish(),
      close: async () => finish(),
    }
  }
}
const provider = new ScriptedProvider()

async function stopClient(): Promise<void> {
  if (!electron || electron.exitCode !== null || electron.signalCode !== null) return
  if (electron.connected) electron.send({ close: true })
  const timer = setTimeout(() => electron!.kill("SIGKILL"), 3_000)
  await exited
  clearTimeout(timer)
}

async function launchClient(phase: AgentSmokeContext["phase"], previous?: AgentSmokeResult): Promise<AgentSmokeResult> {
  const context: AgentSmokeContext = { phase, rendererDirectory, preloadPath, repository, screenshotPath, questionScreenshotPath, ...previous }
  electron = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${join(directory, `profile-${++clientNumber}`)}`, `--agent-smoke-context=${JSON.stringify(context)}`], {
    cwd: resolve(import.meta.dirname, "../../.."), env: { ...process.env, DESKFLEET_DAEMON_DIRECTORY: controlDirectory }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  exited = new Promise(resolveExit => { electron!.once("exit", () => resolveExit()); electron!.once("error", () => resolveExit()) })
  electron.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
  try {
    return await new Promise<AgentSmokeResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error("Electron Agent smoke timed out")), 90_000)
      const fail = (error: unknown) => { clearTimeout(timer); rejectResult(error) }
      electron!.once("error", fail)
      electron!.once("exit", code => fail(new Error(`Electron exited early (${code})`)))
      electron!.on("message", (message: { result?: AgentSmokeResult; error?: string }) => {
        if (message.error) fail(new Error(message.error))
        if (message.result) { clearTimeout(timer); resolveResult(message.result) }
      })
    })
  } finally { await stopClient() }
}

try {
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/local-preload.ts")], outfile: preloadPath, bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24" })
  await Promise.all([stat(join(rendererDirectory, "index.html")), stat(preloadPath)])
  await mkdir(repository)
  await execute("git", ["init", repository])
  await writeFile(join(repository, "README.md"), "isolated Agent smoke repository\n")
  await execute("git", ["-C", repository, "add", "."])
  await execute("git", ["-C", repository, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"])
  await build({ entryPoints: [join(import.meta.dirname, "fixtures/agent-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" })
  daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null, agentProvider: provider })
  const first = await launchClient("create")
  assert.deepEqual(provider.failures, [])
  assert.deepEqual(provider.prompts, ["Smoke first prompt", "Smoke queued candidate", "Smoke changed model prompt"])
  const launch = { name: "Smoke Codex", binaryPath: `${repository}/smoke-codex`, env: { DESKFLEET_SMOKE_PROFILE: "configured" } }
  const configuredConnections = provider.connectionConfigurations.filter(config => config.name === launch.name)
  assert.ok(configuredConnections.length >= 2, "Draft discovery and Session startup must both use the configured provider")
  for (const config of configuredConnections) assert.deepEqual(config, launch, "Configured provider launch settings must reach discovery and startup")
  assert.deepEqual(provider.promptConfigurations, [
    { model: "fast", reasoningEffort: "high", launch },
    { model: "fast", reasoningEffort: "high", launch },
    { model: "balanced", reasoningEffort: "medium", launch },
  ], "The first prompt must use draft selections and later prompts must use the Session's confirmed configuration")
  assert.deepEqual(provider.steers, ["Smoke selected steer"])
  assert.ok((await stat(join(controlDirectory, "catalog.db"))).size > 0)
  const connections = provider.connections
  await daemon.close()
  daemon = undefined
  daemon = await startDaemon(0, { allowLocalControlForTests: true, controlDirectory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null, agentProvider: provider })
  const restored = await launchClient("restore", first)
  assert.deepEqual(restored, first)
  assert.equal(provider.connections, connections, "Reconnecting must not restart the provider")
  assert.deepEqual(provider.prompts, ["Smoke first prompt", "Smoke queued candidate", "Smoke changed model prompt"])
  console.log("Production Electron Agent: configured providers, dynamic configuration, streaming, backlog, steering, permissions, user question forms, route reattachment, live Git status/diffs, and SQLite replay after daemon/client restart passed", { ...restored, screenshotPath, questionScreenshotPath })
} catch (error) {
  if (diagnostics) console.error(diagnostics)
  if (provider.failures.length) console.error(provider.failures)
  console.error(`Agent smoke screenshot: ${screenshotPath}`)
  console.error(`Agent question screenshot: ${questionScreenshotPath}`)
  throw error
} finally {
  await stopClient()
  await daemon?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
