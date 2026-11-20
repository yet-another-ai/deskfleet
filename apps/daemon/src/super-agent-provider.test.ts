import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentProviders } from "./agent-providers.ts"
import { supportsCodexCoordinatorVersion } from "./super-agent-codex.ts"
import { createCoordinatorRuntime } from "./super-agent-provider.ts"
import { routeSuperMessage } from "./super-agent-router.ts"

test("registered DeepSeek instances use their own keys, a native model-only request and measured usage", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-dsh-provider-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AgentProviders(dir)
  await registry.init()
  const runtime = createCoordinatorRuntime(registry)
  const calls: { key: unknown; body: Record<string, unknown> }[] = []
  const result = { reason: "answered", actions: [{ kind: "answer", text: "ready" }] }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ key: req.headers["x-api-key"], body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of [
      { type: "message_start", message: { usage: { input_tokens: 30 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(result) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server[Symbol.asyncDispose]())
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const env = {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DEEPSEEK_API_KEY: "fixture-key", HOME: dir, USERPROFILE: dir, DSH_HOME: dir,
    ALL_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", all_proxy: "", NO_PROXY: "*",
    DESKFLEET_DSH_CREDENTIALS_PATH: join(dir, "private-credentials.yaml"),
  }
  const settings = { template: "deepseek-harness" as const, name: "Studio", inheritShellEnvironment: false, env }
  const first = await registry.create(settings)
  const second = await registry.create({ ...settings, env: { ...env, DEEPSEEK_API_KEY: "second-key" } })
  assert.equal(runtime.supports(first.id), true)
  const profile = await runtime.options(first.id)
  assert.ok(profile.models.some(item => item.id === "deepseek-flash" && item.reasoningEfforts.includes("low")))
  assert.equal(calls.length, 0)
  for (const id of [second.id, first.id]) {
    let used: number | undefined
    const output = await routeSuperMessage({
      coordinator: id, coordinatorSelection: { model: "deepseek-flash", reasoningEffort: "low" }, workspaceId: null,
      text: "Reply ready", workspaces: [], recent: [], tickets: [],
    }, { model: runtime.model(id), onUsage: usage => { used = usage?.used } })
    assert.partialDeepStrictEqual(output, result)
    assert.equal(used, 35)
  }
  assert.deepEqual(calls.map(call => call.key), ["second-key", "fixture-key"])
  for (const { body } of calls) {
    assert.equal(body.model, "deepseek-flash")
    assert.deepEqual(body.tools ?? [], [])
    assert.match(JSON.stringify(body.messages), /Reply ready/)
    assert.match(JSON.stringify(body.system), /DeskFleet workspace/)
  }
  const custom = await registry.create({ ...settings, binaryPath: "/unverified/dsh" })
  assert.equal(runtime.supports(custom.id), false)
  await registry.remove(first.id)
  assert.equal(runtime.supports(first.id), false)
  assert.deepEqual((await runtime.options(first.id)).models, [])
  await assert.rejects(runtime.model(first.id)({}), /unavailable/)
})

test("desktop DSH routes select the exact adapter and desktop credential for matching model IDs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-dsh-routes-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AgentProviders(dir)
  await registry.init()
  const runtime = createCoordinatorRuntime(registry)
  const requests: { path: string; key?: string; body: Record<string, unknown> }[] = []
  const decision = { reason: "test", actions: [{ kind: "answer", text: "ready" }] }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url!, key: req.headers.authorization, body })
    res.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (delta: object, finish: string | null) => ({
      id: "fixture", model: "shared-model", object: "chat.completion.chunk", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
    res.write("data: " + JSON.stringify(frame({ role: "assistant", content: JSON.stringify(decision) }, null)) + "\n\n")
    res.end("data: " + JSON.stringify(frame({}, "stop")) + "\n\ndata: [DONE]\n\n")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server[Symbol.asyncDispose]())
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const desk = join(dir, "profiles", "desktop")
  await mkdir(desk, { recursive: true })
  const providers = Object.fromEntries(["first", "second"].map(id => [id, {
    api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/${id}`,
    apiKeyEnv: id.toUpperCase() + "_KEY",
    models: [{ id: "shared-model", name: "Shared", contextWindow: 32000, maxTokens: 2048 }],
  }]))
  const patch = join(desk, "cordis.patch.yml")
  await writeFile(patch, JSON.stringify([
    { id: "llm-pi-ai", config: { providers } },
    { id: "agent-default-model", config: { provider: "second", model: "shared-model" } },
  ]))
  const credentials = (first: string, second: string) => JSON.stringify({ version: 1, refs: { FIRST_KEY: first, SECOND_KEY: second }, records: {} })
  await writeFile(join(dir, ".credentials.yaml"), credentials("desktop-first", "desktop-second"), { mode: 0o600 })
  const registration = join(dir, "private.yaml")
  await writeFile(registration, credentials("registration-first", "registration-second"), { mode: 0o600 })
  const settings = { name: "Dsh", template: "deepseek-harness" as const, inheritShellEnvironment: false, env: {
    DSH_HOME: dir, DESKFLEET_DSH_DESKTOP_ROUTES: "1", DESKFLEET_DSH_CREDENTIALS_PATH: registration,
    DEEPSEEK_API_KEY: "private-official", NO_PROXY: "*", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
  } }
  const { id } = await registry.create(settings)
  const first = JSON.stringify(["first", "shared-model"])
  const second = JSON.stringify(["second", "shared-model"])
  const options = await runtime.options(id)
  assert.equal(options.defaultModel, second)
  assert.ok(options.models.some(m => m.id === "deepseek-flash"), "legacy bare DeepSeek selections remain valid")
  assert.deepEqual(options.models.filter(m => m.id === first || m.id === second).map(m => m.name).sort(), ["first / Shared", "second / Shared"])
  assert.equal(requests.length, 0)
  for (const model of [first, undefined]) {
    const value = await runtime.model(id)({ message: "route probe" }, undefined, undefined, { selection: { model } })
    assert.deepEqual(value, decision)
  }
  assert.deepEqual(requests.map(r => [r.path, r.key]), [
    ["/first/chat/completions", "Bearer desktop-first"], ["/second/chat/completions", "Bearer desktop-second"],
  ])
  for (const { body } of requests) {
    assert.equal(body.model, "shared-model")
    assert.deepEqual(body.tools ?? [], [])
  }
  await writeFile(patch, JSON.stringify([{ id: "llm-pi-ai", config: { providers: { second: providers.second } } }]))
  await assert.rejects(runtime.model(id)({}, undefined, undefined, { selection: { model: first } }), /no longer available/)
  assert.equal(requests.length, 2, "an unavailable pinned route must not fall back to another provider")
  const foreignGrant = JSON.stringify({ version: 1, refs: {}, records: {
    "deepseek-account-platform/default": { kind: "grant", payload: { version: 1, issuer: "https://old.invalid", token: "fixture" } },
  } })
  await writeFile(registration, foreignGrant)
  const brokenPrivate = await registry.create({ ...settings, env: { ...settings.env, DEEPSEEK_API_KEY: "" } })
  assert.deepEqual((await runtime.options(brokenPrivate.id)).models.map(m => m.id), [second])
  assert.deepEqual(await runtime.model(brokenPrivate.id)({}, undefined, undefined, { selection: { model: second } }), decision)
  assert.equal(requests.at(-1)?.key, "Bearer desktop-second")
  assert.equal(await readFile(registration, "utf8"), foreignGrant)
  await assert.rejects(runtime.model(brokenPrivate.id)({}, undefined, undefined, { selection: { model: "deepseek-flash" } }), /no longer available/)

})

test("registered Claude uses the chosen instance executable and environment for discovery and inference", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-claude-provider-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, "fixture-claude")
  await writeFile(binary, `#!/bin/sh
input=$(cat)
case "$input" in
  *control_request*) echo '{"type":"control_response","response":{"request_id":"coordinator-models","response":{"models":[{"value":"fixture","displayName":"Fixture"}]}}}' ;;
  *) echo '{"type":"result","structured_output":{"instance":"'"$FIXTURE_INSTANCE"'"}}' ;;
esac`, { mode: 0o700 })
  const registry = new AgentProviders(dir)
  await registry.init()
  const runtime = createCoordinatorRuntime(registry)
  const settings = { template: "claude-code" as const, name: "Custom", binaryPath: binary, env: { FIXTURE_INSTANCE: "one" }, inheritShellEnvironment: false }
  const first = await registry.create(settings)
  const second = await registry.create({ ...settings, env: { FIXTURE_INSTANCE: "two" } })
  assert.deepEqual((await runtime.options(first.id)).models.map(m => m.id), ["fixture"])
  assert.deepEqual(await runtime.model(second.id)({ message: "hello" }), { instance: "two" })
  await registry.update(first.id, { name: settings.name, inheritShellEnvironment: false, env: settings.env, binaryPath: join(dir, "missing") })
  assert.deepEqual((await runtime.options(first.id)).models, [])
})

test("registered Codex routes an explicit API key only to its configured origin, independent of the saved account", { skip: process.platform !== "darwin" }, async t => {
  const { execFileSync } = await import("node:child_process")
  const { superModelBinary } = await import("./super-agent-model.ts")
  let binary: string
  try {
    binary = await superModelBinary("codex")
    if (!supportsCodexCoordinatorVersion(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim())) return t.skip("Requires the verified Codex CLI")
  } catch { return t.skip("Codex CLI unavailable") }
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-codex-provider-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-other-account" }))
  const calls: { path?: string; auth?: string }[] = []
  const server = createServer((request, response) => {
    calls.push({ path: request.url, auth: request.headers.authorization })
    request.resume()
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "Synthetic fixture received request", type: "invalid_request_error" } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server[Symbol.asyncDispose]())
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const env = { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, CODEX_HOME: dir, HOME: dir, NO_PROXY: "127.0.0.1", OPENAI_API_KEY: "fixture-instance", CODEX_API_KEY: "" }
  const registry = new AgentProviders(dir)
  await registry.init()
  const runtime = createCoordinatorRuntime(registry)
  const settings = { name: "Custom Codex", binaryPath: binary, env, inheritShellEnvironment: false }
  const record = await registry.create({ ...settings, template: "codex" })
  await assert.rejects(runtime.model(record.id)({ message: "synthetic" }), /Codex/)
  const posts = calls.filter(call => call.path === "/v1/responses")
  assert.ok(posts.length, "the registered endpoint received the request")
  assert.ok(posts.every(call => call.auth === "Bearer fixture-instance"))
  const count = calls.length
  await registry.update(record.id, { ...settings, env: { ...env, OPENAI_API_KEY: "" } })
  await assert.rejects(runtime.model(record.id)({ message: "synthetic" }), /requires its own API key/)
  assert.equal(calls.length, count)
})
