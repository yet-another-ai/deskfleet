import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { AgentProviders } from "./agent-providers.ts"
import type { AgentProviderInput } from "./provider-protocol.ts"
import { discoverProviderMcpServers } from "./provider-mcp-servers.ts"

const input = (template: AgentProviderInput["template"], overrides: Partial<AgentProviderInput> = {}): AgentProviderInput => ({
  template, name: template, inheritShellEnvironment: false, env: {}, ...overrides,
})

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "df-provider-mcp-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = join(home, "bin")
  const project = join(home, "project")
  await mkdir(bin)
  await mkdir(project)
  const command = join(bin, process.platform === "win32" ? "fixture-mcp.exe" : "fixture-mcp")
  await writeFile(command, "This fixture must never be executed", { mode: 0o700 })
  const dependencies = { home, env: { PATH: bin } }
  async function codex(contents: string, directory = join(home, ".codex")) {
    await mkdir(directory, { recursive: true })
    const source = join(directory, "config.toml")
    await writeFile(source, contents)
    return source
  }
  async function claude(config: unknown, directory = home) {
    await mkdir(directory, { recursive: true })
    const source = join(directory, ".claude.json")
    await writeFile(source, JSON.stringify(config))
    return source
  }
  return { home, bin, project, command, dependencies, codex, claude }
}

test("Codex imports stdio paths, explicit and forwarded environment values without executing servers", async t => {
  const f = await fixture(t)
  const contents = `[mcp_servers.local]\ncommand = 'fixture-mcp'\nargs = ['--serve', '--name=one']\nenabled = false\nenv_vars = ['FORWARDED', { name = 'LOCAL_SOURCE', source = 'local' }]\n[mcp_servers.local.env]\nEXPLICIT = 'literal-value'\nFORWARDED = 'explicit-wins'\n`
  const source = await f.codex(contents)
  const result = await discoverProviderMcpServers(input("codex", { env: { FORWARDED: "forwarded-value", LOCAL_SOURCE: "local-value" } }), f.dependencies)
  assert.equal(result.warnings.length, 0)
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.candidates[0], {
    id: JSON.stringify([source, "user", null, "local"]), name: "local", source, scope: "user",
    server: { name: "local", enabled: false, transport: "stdio", command: f.command, args: ["--serve", "--name=one"],
      env: { PATH: f.bin, FORWARDED: "explicit-wins", LOCAL_SOURCE: "local-value", EXPLICIT: "literal-value" } },
  })
  assert.equal(await readFile(source, "utf8"), contents)
})

test("Codex HTTP imports static headers, environment headers and bearer authentication", async t => {
  const f = await fixture(t)
  const custom = join(f.home, "custom-codex")
  await f.codex(`[mcp_servers.remote]\nurl = 'https://mcp.example.test/api'\nbearer_token_env_var = 'MCP_TOKEN'\n[mcp_servers.remote.http_headers]\nX-Static = 'static-value'\nx-account = 'old-value'\nAuthorization = 'old-token'\n[mcp_servers.remote.env_http_headers]\nX-Account = 'ACCOUNT'\n`, custom)
  const result = await discoverProviderMcpServers(input("codex", { env: { CODEX_HOME: custom, MCP_TOKEN: "private-token", ACCOUNT: "account-value" } }), f.dependencies)
  assert.deepEqual(result.candidates[0]?.server, { name: "remote", enabled: true, transport: "http", url: "https://mcp.example.test/api",
    headers: { "X-Static": "static-value", "X-Account": "account-value", Authorization: "Bearer private-token" } })
  assert.deepEqual(result.warnings, [])
})

test("Claude resolves substitutions, unset defaults and explicitly empty variables with provider environment precedence", async t => {
  const f = await fixture(t)
  const custom = join(f.home, "custom-claude")
  await f.claude({ mcpServers: {
    local: { command: "${COMMAND}", args: ["${ARG:-fallback}", "${EMPTY:-unused}"], env: { TOKEN: "${TOKEN}" } },
    remote: { type: "sse", url: "${BASE:-https://mcp.example.test}/events", headers: { Authorization: "Bearer ${TOKEN}" } },
  } }, custom)
  let shellLoads = 0
  const result = await discoverProviderMcpServers(input("claude-code", {
    inheritShellEnvironment: true, env: { CLAUDE_CONFIG_DIR: custom, TOKEN: "manual-token", EMPTY: "" },
  }), { ...f.dependencies, shellEnvironment: async () => { shellLoads++; return { TOKEN: "shell-token", COMMAND: "fixture-mcp" } } })
  assert.equal(shellLoads, 1)
  assert.deepEqual(result.candidates.map(candidate => candidate.server), [
    { name: "local", enabled: true, transport: "stdio", command: f.command, args: ["fallback", ""], env: { PATH: f.bin, TOKEN: "manual-token" } },
    { name: "remote", enabled: true, transport: "sse", url: "https://mcp.example.test/events", headers: { Authorization: "Bearer manual-token" } },
  ])
})

test("Claude discovers private project and shared project servers with distinct sources and disabled state", async t => {
  const f = await fixture(t)
  const source = await f.claude({
    mcpServers: { user: { type: "http", url: "https://user.example.test" } },
    projects: { [f.project]: { mcpServers: { local: { type: "http", url: "https://local.example.test" } }, disabledMcpServers: ["local", "shared"] } },
  })
  const projectSource = join(f.project, ".mcp.json")
  await writeFile(projectSource, JSON.stringify({ mcpServers: { shared: { type: "http", url: "https://shared.example.test" } } }))
  const result = await discoverProviderMcpServers(input("claude-code"), f.dependencies)
  assert.deepEqual(result.candidates.map(candidate => [candidate.name, candidate.source, candidate.scope, candidate.projectPath, candidate.server?.enabled]), [
    ["user", source, "user", undefined, true], ["local", source, "project", f.project, false], ["shared", projectSource, "project", f.project, false],
  ])
  assert.equal(new Set(result.candidates.map(candidate => candidate.id)).size, 3)
})

test("Codex only scans trusted existing projects and preserves inherited server fields in project overrides", async t => {
  const f = await fixture(t)
  const untrusted = join(f.home, "untrusted")
  await mkdir(join(untrusted, ".codex"), { recursive: true })
  await writeFile(join(untrusted, ".codex", "config.toml"), "invalid secret-config")
  await f.codex(`[mcp_servers.shared]\nurl = 'https://mcp.example.test'\n[mcp_servers.shared.http_headers]\nX-User = 'user'\n[projects.${JSON.stringify(f.project)}]\ntrust_level = 'trusted'\n[projects.${JSON.stringify(untrusted)}]\ntrust_level = 'untrusted'\n`)
  await f.codex(`[mcp_servers.shared]\nenabled = false\n[mcp_servers.shared.http_headers]\nX-Project = 'project'\n`, join(f.project, ".codex"))
  const result = await discoverProviderMcpServers(input("codex"), f.dependencies)
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(result.candidates[1]?.server, { name: "shared", transport: "http", enabled: false, url: "https://mcp.example.test/", headers: { "X-User": "user", "X-Project": "project" } })
  assert.equal(result.candidates[1]?.projectPath, f.project)
  assert.deepEqual(result.warnings, [])
})

test("unsupported behavioral and authentication settings remain visible without executing helpers or losing restrictions", async t => {
  const f = await fixture(t)
  await f.claude({ mcpServers: {
    helper: { type: "http", url: "https://example.test", headersHelper: "secret-helper-command" },
    oauth: { type: "http", url: "https://example.test", oauth: { clientSecret: "secret-oauth-value" } },
    websocket: { type: "ws", url: "wss://example.test" },
    relative: { command: "./relative-server", args: [] },
    missing: { command: "unavailable-executable" },
    unset: { type: "http", url: "https://example.test", headers: { Authorization: "Bearer ${UNSET}" } },
  } })
  const result = await discoverProviderMcpServers(input("claude-code"), f.dependencies)
  assert.equal(result.candidates.length, 6)
  assert.ok(result.candidates.every(candidate => !candidate.server && candidate.unsupportedReason))
  assert.match(result.candidates[0]!.unsupportedReason!, /not executed/u)
  assert.match(result.candidates[3]!.unsupportedReason!, /relative executable/u)
  assert.doesNotMatch(JSON.stringify(result), /secret-helper-command|secret-oauth-value/u)
  await f.codex(`[mcp_servers.cwd]\ncommand = 'fixture-mcp'\ncwd = '/private-workdir'\n[mcp_servers.restricted]\nurl = 'https://example.test'\nenabled_tools = ['limited-tool']\n[mcp_servers.timeout]\nurl = 'https://example.test'\nstartup_timeout_sec = 30\n[mcp_servers.remote]\ncommand = 'fixture-mcp'\nenvironment_id = 'remote-id'\n`)
  const codex = await discoverProviderMcpServers(input("codex"), f.dependencies)
  assert.equal(codex.candidates.length, 4)
  assert.ok(codex.candidates.every(candidate => !candidate.server && candidate.unsupportedReason))
  assert.doesNotMatch(JSON.stringify(codex), /private-workdir|limited-tool|remote-id/u)
})

test("Claude remote credential references are not materialized and invalid settings do not leak values", async t => {
  const f = await fixture(t)
  await f.claude({ mcpServers: {
    protected: { type: "http", url: "https://example.test", headers: { Authorization: "${ANTHROPIC_API_KEY}" } },
    invalid: { type: "http", url: "https://user:private-password@example.test" },
    badHeader: { type: "http", url: "https://example.test", headers: { Authorization: "private-value\r\nInjected: value" } },
    pluginVariable: { type: "http", url: "https://example.test", headers: { Authorization: "${user_config.API_KEY}" } },
    providerUrl: { type: "http", url: "https://example.test", headers: { "X-Provider": "${ANTHROPIC_BASE_URL}" } },
  } })
  const result = await discoverProviderMcpServers(input("claude-code", { env: {
    ANTHROPIC_API_KEY: "private-key", ANTHROPIC_BASE_URL: "https://user:private-url-password@provider.example.test",
  } }), f.dependencies)
  assert.ok(result.candidates.every(candidate => !candidate.server && candidate.unsupportedReason))
  assert.doesNotMatch(JSON.stringify(result), /private-password|private-value|private-key|private-url-password/u)
  assert.match(result.candidates.at(-1)!.unsupportedReason!, /base URL containing credentials/u)
})

test("Claude's streamable-http alias imports as the native HTTP transport", async t => {
  const f = await fixture(t)
  await f.claude({ mcpServers: { alias: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Provider": "${ANTHROPIC_BASE_URL}" } } } })
  const result = await discoverProviderMcpServers(input("claude-code", { env: { ANTHROPIC_BASE_URL: "https://provider.example.test" } }), f.dependencies)
  assert.deepEqual(result.candidates[0]?.server, { name: "alias", enabled: true, transport: "http", url: "https://example.test/mcp", headers: { "X-Provider": "https://provider.example.test" } })
})

test("saved providers, reserved names and project-relative executables stay importable for review and rename", async t => {
  const f = await fixture(t)
  await f.claude({ mcpServers: { deskfleet: { type: "http", url: "https://example.test" } }, projects: { [f.project]: {} } })
  const relative = join(f.project, "server")
  await writeFile(relative, "Do not execute", { mode: 0o700 })
  await writeFile(join(f.project, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "./server" } } }))
  const providers = new AgentProviders(join(f.home, "registry"))
  await providers.init()
  const provider = await providers.create(input("claude-code", { env: { CLAUDE_CONFIG_DIR: f.home } }))
  const result = await discoverProviderMcpServers(providers.get(provider.id), f.dependencies)
  assert.equal(result.candidates[0]?.server?.name, "deskfleet")
  const server = result.candidates[1]?.server
  assert.ok(server?.transport === "stdio")
  assert.equal(server.command, relative)
})

test("missing, malformed, unsupported and unreadable configurations give safe results", async t => {
  const f = await fixture(t)
  assert.deepEqual(await discoverProviderMcpServers(input("codex"), f.dependencies), { supported: true, candidates: [], warnings: [] })
  const source = await f.codex('secret = "private-incomplete-value')
  const malformed = await discoverProviderMcpServers(input("codex"), f.dependencies)
  assert.equal(malformed.warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(malformed), /private-incomplete-value/u)
  await rm(source)
  await mkdir(source)
  assert.equal((await discoverProviderMcpServers(input("codex"), f.dependencies)).warnings.length, 1)
  const deps = { ...f.dependencies, shellEnvironment: async () => { throw new Error("private-shell-output") } }
  assert.deepEqual(await discoverProviderMcpServers(input("acp", { inheritShellEnvironment: true }), deps), { supported: false, candidates: [], warnings: [] })
  const shell = await discoverProviderMcpServers(input("codex", { inheritShellEnvironment: true }), deps)
  assert.equal(shell.warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(shell), /private-shell-output/u)
})
