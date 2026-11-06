import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { accountStatus, acpPatchFiles, callbackUrl, createAccountServices, readHiddenLines, relayCallback, runAccountLogin } from "./helper.ts"
import { sourceDshRuntime } from "./index.ts"

test("account selection retains API key precedence and only patches stored account sessions", async () => {
  const services = { apiKeyConfigured: async () => true, accountStored: async () => { throw new Error("unneeded") } }
  assert.deepEqual(await accountStatus(services), { auth: "authenticated", method: "api-key" })
  assert.deepEqual(acpPatchFiles(await accountStatus(services), undefined), [])
  const account = await accountStatus({ apiKeyConfigured: async () => false, accountStored: async () => true })
  assert.deepEqual(account, { auth: "authenticated", method: "account" })
  assert.deepEqual(acpPatchFiles(account, undefined, "fixture"), [join("fixture", "account-acp.yml")])
  assert.deepEqual(acpPatchFiles(account, "private/credentials.yaml", "fixture"),
    [join("fixture", "credentials-acp.yml"), join("fixture", "account-acp.yml")])
  assert.deepEqual(acpPatchFiles({ auth: "authenticated", method: "api-key" }, "private/credentials.yaml", "fixture"),
    [join("fixture", "credentials-acp.yml")])
  assert.deepEqual(await accountStatus({ apiKeyConfigured: async () => false, accountStored: async () => false }), { auth: "unauthenticated" })
})

test("redirect input accepts only the exact helper callback with one state and code", () => {
  const origin = "http://127.0.0.1:41523"
  const valid = `${origin}/oauth/callback?code=private-code&state=private-state`
  assert.equal(callbackUrl(` ${valid} `, origin), valid)
  for (const candidate of [
    "https://attacker.invalid/oauth/callback?code=x&state=y",
    valid.replace(":41523", ":41524"), valid.replace("127.0.0.1", "localhost"),
    valid.replace("/oauth/callback", "/api"), valid.replace("http:", "https:"),
    valid.replace("//", "//user:password@"), `${valid}#fragment`, `${valid}&code=another`,
    `${valid}&state=another`, `${valid}&redirect=http://other.invalid`, `${origin}/oauth/callback?code=x`,
  ]) assert.equal(callbackUrl(candidate, origin), undefined)
})

test("callback relay bypasses the fetch proxy and returns redirects without following them", async t => {
  let calls = 0
  const server = createServer((_request, response) => {
    calls++
    response.writeHead(302, { location: "https://example.invalid/not-a-callback" }).end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("callback must not use fetch") })
    assert.equal(await relayCallback(`http://127.0.0.1:${address.port}/oauth/callback?code=private&state=state`, new AbortController().signal), 302)
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(calls, 1)
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
})

test("hidden terminal reader restores raw mode and never echoes pasted redirect input", () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(raw: boolean): void }
  const modes: boolean[] = []
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = raw => { modes.push(raw); input.isRaw = raw }
  const lines: string[] = []
  let cancelled = false
  const dispose = readHiddenLines(input, line => lines.push(line), () => { cancelled = true })
  input.write("private-codx\b")
  input.write("e\r\n\u0003")
  dispose()
  assert.deepEqual(lines, ["private-code"])
  assert.deepEqual(modes, [true, false])
  assert.equal(cancelled, true)
  input.destroy()
})

test("real status helper ignores incidental dotenv but retains global credentials without exposing secrets", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "df-dsh-status-"))
  const home = join(directory, "home")
  const harness = join(directory, "harness")
  const workspace = join(directory, "workspace")
  const runtime = sourceDshRuntime()
  try {
    await Promise.all([home, harness, workspace].map(path => mkdir(path)))
    const env = { ...process.env, DSH_HOME: harness, HOME: home, USERPROFILE: home,
      DESKFLEET_DSH_CREDENTIALS_PATH: join(home, "registration-credentials.yaml"),
      DEEPSEEK_API_KEY: "", NODE_OPTIONS: "", NODE_PATH: "" }
    const run = async (cwd = home, overrides: NodeJS.ProcessEnv = {}) => {
      const output = await promisify(execFile)(runtime.command,
        [runtime.helperEntryPoint, "status", runtime.entryPoint], { cwd, env: { ...env, ...overrides }, timeout: 20_000 })
      assert.doesNotMatch(output.stdout + output.stderr, /fixture-\S*-secret/)
      return JSON.parse(output.stdout)
    }
    await writeFile(join(home, ".env"), "DEEPSEEK_API_KEY=fixture-home-secret\n")
    await writeFile(join(workspace, ".env"), "DEEPSEEK_API_KEY=fixture-project-secret\n")
    assert.deepEqual(await run(), { auth: "unauthenticated" })
    assert.deepEqual(await run(workspace), { auth: "unauthenticated" })
    await writeFile(env.DESKFLEET_DSH_CREDENTIALS_PATH, JSON.stringify({ version: 1, refs: {}, records: {
      "deepseek-account-platform/default": { kind: "grant", payload: {
        version: 1, issuer: "https://platform.deepseek.com", token: "fixture-account-secret",
      } },
    } }), { mode: 0o600 })
    assert.deepEqual(await run(), { auth: "authenticated", method: "account" })
    await writeFile(join(harness, ".env"), "DEEPSEEK_API_KEY=fixture-harness-secret\n")
    assert.deepEqual(await run(), { auth: "authenticated", method: "api-key" })
    await rm(join(harness, ".env"))
    assert.deepEqual(await run(home, { DEEPSEEK_API_KEY: "fixture-inherited-secret" }), { auth: "authenticated", method: "api-key" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("setup retains home environment provenance while ACP opts into project dotenv", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "df-dsh-layers-"))
  const home = join(directory, "home")
  const harness = join(directory, "harness")
  const workspace = join(directory, "workspace")
  const runtime = sourceDshRuntime()
  try {
    await Promise.all([home, harness, workspace].map(path => mkdir(path)))
    await writeFile(join(harness, ".env"), "DEEPSEEK_API_KEY=fixture-harness-secret\nHTTP_PROXY=http://127.0.0.1:3128\n")
    await writeFile(join(workspace, ".env"), "DEEPSEEK_API_KEY=fixture-project-secret\n")
    const script = join(directory, "environment.mjs")
    await writeFile(script, `
      import { createAccountServices } from ${JSON.stringify(pathToFileURL(runtime.helperEntryPoint).href)};
      const projectEnv = process.argv[3] === 'true';
      const services = await createAccountServices(process.argv[2], false, { projectEnv });
      try {
        const environment = services.environment;
        const key = environment.get('DEEPSEEK_API_KEY');
        const source = sources => environment.getFrom('HTTP_PROXY', sources)?.source ?? null;
        console.log(JSON.stringify({
          keySource: key?.source,
          keyMatches: key?.value === (projectEnv ? 'fixture-project-secret' : 'fixture-harness-secret'),
          homeProxy: source(['user-env']), projectProxy: source(['project-env']), inheritedProxy: source(['process']),
        }));
      } finally { await services.dispose(); }
    `)
    const env = { ...Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !["DEEPSEEK_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].includes(name.toUpperCase()))),
      HOME: home, USERPROFILE: home, DSH_HOME: harness,
      DESKFLEET_DSH_CREDENTIALS_PATH: join(directory, "registration.yaml"), NODE_OPTIONS: "", NODE_PATH: "" }
    for (const projectEnv of [false, true]) {
      const output = await promisify(execFile)(runtime.command, [script, runtime.entryPoint, String(projectEnv)], {
        cwd: workspace, env, timeout: 20_000,
      })
      assert.doesNotMatch(output.stdout + output.stderr, /fixture-\S*-secret/)
      assert.deepEqual(JSON.parse(output.stdout), {
        keySource: projectEnv ? "project-env" : "user-env", keyMatches: true,
        homeProxy: "user-env", projectProxy: null, inheritedProxy: null,
      })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const projectKey of [false, true]) test(`real ACP helper selects ${projectKey ? "project API key over stored account" : "the stored account route"} without network or a model prompt`, { timeout: 45_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "df-dsh-account-acp-"))
  const runtime = sourceDshRuntime()
  const credentials = join(home, "registration-credentials.yaml")
  const guard = join(home, "offline.mjs")
  await writeFile(credentials, JSON.stringify({ version: 1, refs: {}, records: {
    "deepseek-account-platform/default": { kind: "grant", payload: {
      version: 1, issuer: "https://platform.deepseek.com", token: "fixture-account-token-never-print",
    } },
  } }), { mode: 0o600 })
  if (projectKey) await writeFile(join(home, ".env"), "DEEPSEEK_API_KEY=fixture-project-secret\n")
  // Discovery falls back to its shipped catalog on this synthetic HTTP failure.
  // Deny sockets too, so neither model discovery nor an unexpected plugin can reach the network.
  await writeFile(guard, `
    import { Socket } from 'node:net';
    Socket.prototype.connect = function () { throw new Error('Network is disabled in this fixture'); };
    globalThis.fetch = async () => new Response('{}', { status: 503 });
  `)
  const env = Object.fromEntries(Object.entries({ ...process.env,
    PATH: "", NODE_OPTIONS: "", NODE_PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    DSH_HOME: join(home, "harness"), DSH_AGENTS_HOME: join(home, "agents"),
    DESKFLEET_DSH_CREDENTIALS_PATH: credentials, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DSH_TELEMETRY_MODE: "DISABLED", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "",
  }).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
  const child = spawn(runtime.command, ["--import", pathToFileURL(guard).href, runtime.helperEntryPoint, "acp", runtime.entryPoint], {
    env, cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  const connection = acp.client({ name: "deskfleet-account-route-test" }).connect(acp.ndJsonStream(
    Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  child.once("error", error => connection.close(error))
  child.once("exit", (code, signal) => connection.close(new Error(`dsh ACP exited (${signal ?? code}): ${stderr}`)))
  const deadline = setTimeout(() => connection.close(new Error("account ACP fixture timed out")), 30_000)
  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "deskfleet-account-route-test", version: "1" }, clientCapabilities: {},
    })
    const session = await connection.agent.request(acp.methods.agent.session.new, { cwd: home, mcpServers: [] })
    assert.ok(session.sessionId)
    const model = session.configOptions?.find(option => option.id === "model")
    assert.ok(model && model.type === "select", "ACP must advertise its selected model")
    const selected = JSON.parse(model.currentValue)
    if (projectKey) assert.equal(selected[0], "deepseek-official")
    else assert.deepEqual(selected, ["deepseek-account", "deepseek-flash"])
    assert.doesNotMatch(stderr, /fixture-account-token-never-print|fixture-project-secret/)
  } finally {
    clearTimeout(deadline)
    child.stdin.end()
    connection.close()
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try { assert.deepEqual(await exited, { code: 0, signal: null }, stderr) }
    finally {
      clearTimeout(shutdown)
      await rm(home, { recursive: true, force: true })
    }
  }
})

test("official login validates callback state, persists completion, and preserves credentials on failure or cancellation", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "df-dsh-login-"))
  let origin = ""
  let callback = ""
  let exchangeFails = false
  let exchanges = 0
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw) as Record<string, string>
    let data: unknown = null
    if (request.url?.endsWith("auth_init")) {
      assert.ok(body.code_challenge)
      assert.equal(body.code_challenge_method, "S256")
      callback = `${body.redirect_uri}?code=private-code&state=${body.state}`
      data = { authorize_url: `${origin}/dsh/authorize?authorize_id=fixture`, authorize_id: "fixture", expires_in: 60 }
    } else if (request.url?.endsWith("auth_exchange")) {
      exchanges++
      assert.equal(body.code, "private-code")
      assert.ok(body.code_verifier)
      data = { token: "fixture-private-token", authorized_url: `${origin}/dsh/authorized`, user: null }
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ code: 0, data: { biz_code: exchangeFails && request.url?.endsWith("auth_exchange") ? 1 : 0, biz_data: data } }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  origin = `http://127.0.0.1:${address.port}`
  const environment = { get: () => undefined, getFrom: () => undefined }
  let services: Awaited<ReturnType<typeof createAccountServices>> | undefined
  try {
    services = await createAccountServices(sourceDshRuntime().entryPoint, true, {
      home, environment, platform: { platformOrigin: origin, allowLoopbackHttp: true },
    })
    let output = ""
    let wrongStateStatus: number | undefined
    const input = new PassThrough()
    const success = await runAccountLogin(services, { input, write: text => {
      output += text
      if (!text.includes("Open this URL")) return
      void fetch(callback.replace(/state=[^&]+/, "state=wrong")).then(async response => {
        wrongStateStatus = response.status
        await response.arrayBuffer()
        input.write(`${callback}\n`)
      })
    } })
    input.destroy()
    assert.equal(success, true)
    assert.equal(wrongStateStatus, 400)
    assert.equal(exchanges, 1)
    assert.equal((await services.account!.getState()).status, "credential-stored")
    assert.doesNotMatch(output, /private-code|fixture-private-token/)
    const before = await readFile(join(home, ".credentials.yaml"), "utf8")
    exchangeFails = true
    const failedInput = new PassThrough()
    assert.equal(await runAccountLogin(services, { input: failedInput, write: text => {
      if (text.includes("Open this URL")) failedInput.write(`${callback}\n`)
    } }), false)
    failedInput.destroy()
    assert.equal(await readFile(join(home, ".credentials.yaml"), "utf8"), before)
    const cancelledInput = new PassThrough()
    const cancel = new AbortController()
    assert.equal(await runAccountLogin(services, { input: cancelledInput, signal: cancel.signal, write: text => {
      if (text.includes("Open this URL")) cancel.abort()
    } }), false)
    cancelledInput.destroy()
    assert.equal(await readFile(join(home, ".credentials.yaml"), "utf8"), before)
    const probe = await createAccountServices(sourceDshRuntime().entryPoint, false, { home, environment })
    try {
      assert.deepEqual(await accountStatus(probe), { auth: "authenticated", method: "account" })
      assert.equal(probe.account, undefined)
      assert.equal(await readFile(join(home, ".credentials.yaml"), "utf8"), before)
    } finally { await probe.dispose() }
    await assert.rejects(createAccountServices(sourceDshRuntime().entryPoint, true, { home, environment }), /another Harness account configuration/)
    assert.equal(await readFile(join(home, ".credentials.yaml"), "utf8"), before)
  } finally {
    await services?.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await rm(home, { recursive: true, force: true })
  }
})
