import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import test, { type TestContext } from "node:test"
import { AgentProviders } from "./agent-providers.ts"
import type { AgentProviderInput } from "./provider-protocol.ts"
import { discoverProviderWorkspaces } from "./provider-workspaces.ts"

const input = (template: AgentProviderInput["template"], overrides: Partial<AgentProviderInput> = {}): AgentProviderInput => ({
  template, name: template, inheritShellEnvironment: false, env: {}, ...overrides,
})

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "df-provider-workspaces-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, "my.project")
  await mkdir(project)
  return { home, project, dependencies: { home, env: {} } }
}

test("Codex discovers configured projects and deduplicates normalized existing directory paths", async t => {
  const f = await fixture(t)
  const directory = join(f.home, "custom-codex")
  await mkdir(directory)
  const file = join(f.home, "file")
  await writeFile(file, "not a directory")
  const source = join(directory, "config.toml")
  const projects = [f.project, `${f.project}${sep}.`, join(f.home, "missing"), file, "relative/path", "bad\0path"]
  await writeFile(source, projects.map(project => `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"`).join("\n"))
  const result = await discoverProviderWorkspaces(input("codex", { env: { CODEX_HOME: directory } }), f.dependencies)
  assert.deepEqual(result, { supported: true, candidates: [{ name: "my.project", path: f.project, source }], warnings: [] })
})

test("Codex reads the default home config and supports inline TOML project tables", async t => {
  const f = await fixture(t)
  const directory = join(f.home, ".codex")
  await mkdir(directory)
  const source = join(directory, "config.toml")
  await writeFile(source, `projects = { ${JSON.stringify(f.project)} = { trust_level = 'trusted' } }\n`)
  assert.deepEqual((await discoverProviderWorkspaces(input("codex"), f.dependencies)).candidates, [
    { name: "my.project", path: f.project, source },
  ])
})

test("Claude reads global project paths and honors CLAUDE_CONFIG_DIR instead of the default profile", async t => {
  const f = await fixture(t)
  const defaultSource = join(f.home, ".claude.json")
  await writeFile(defaultSource, JSON.stringify({ projects: { [f.project]: { hasTrustDialogAccepted: true } }, oauthAccount: { secret: "private" } }))
  assert.deepEqual((await discoverProviderWorkspaces(input("claude-code"), f.dependencies)).candidates, [
    { name: "my.project", path: f.project, source: defaultSource },
  ])
  const directory = join(f.home, "other-profile")
  await mkdir(directory)
  const source = join(directory, ".claude.json")
  await writeFile(source, JSON.stringify({ projects: { [directory]: {}, [`${directory}${sep}.`]: {} } }))
  const discovered = await discoverProviderWorkspaces(input("claude-code", { env: { CLAUDE_CONFIG_DIR: directory } }), f.dependencies)
  assert.deepEqual(discovered, { supported: true, candidates: [{ name: "other-profile", path: directory, source }], warnings: [] })
})

test("discovery accepts saved provider settings returned by the registry", async t => {
  const f = await fixture(t)
  const source = join(f.home, ".claude.json")
  await writeFile(source, JSON.stringify({ projects: { [f.project]: {} } }))
  const registry = new AgentProviders(join(f.home, "registry"))
  await registry.init()
  const saved = await registry.create(input("claude-code", { env: { CLAUDE_CONFIG_DIR: f.home } }))
  assert.deepEqual(await discoverProviderWorkspaces(registry.get(saved.id), f.dependencies), {
    supported: true, candidates: [{ name: "my.project", path: f.project, source }], warnings: [],
  })
})

test("discovery applies inherited shell environment before explicit provider overrides", async t => {
  const f = await fixture(t)
  const shellDirectory = join(f.home, "shell")
  const manualDirectory = join(f.home, "manual")
  for (const directory of [shellDirectory, manualDirectory]) {
    await mkdir(directory)
    await writeFile(join(directory, ".claude.json"), JSON.stringify({ projects: { [directory]: {} } }))
  }
  let loads = 0
  const dependencies = { ...f.dependencies, env: { CLAUDE_CONFIG_DIR: join(f.home, "process") },
    shellEnvironment: async () => { loads++; return { CLAUDE_CONFIG_DIR: shellDirectory } } }
  assert.equal((await discoverProviderWorkspaces(input("claude-code", { inheritShellEnvironment: true }), dependencies)).candidates[0]?.path, shellDirectory)
  assert.equal((await discoverProviderWorkspaces(input("claude-code", {
    inheritShellEnvironment: true, env: { CLAUDE_CONFIG_DIR: manualDirectory },
  }), dependencies)).candidates[0]?.path, manualDirectory)
  assert.equal(loads, 2)
  await discoverProviderWorkspaces(input("claude-code"), dependencies)
  assert.equal(loads, 2)
})

test("missing configuration produces an empty result and malformed configuration reports only a safe warning", async t => {
  const f = await fixture(t)
  for (const template of ["codex", "claude-code"] as const) {
    assert.deepEqual(await discoverProviderWorkspaces(input(template), f.dependencies), { supported: true, candidates: [], warnings: [] })
  }
  await mkdir(join(f.home, ".codex"))
  await writeFile(join(f.home, ".codex", "config.toml"), 'token = "secret-private-token')
  await writeFile(join(f.home, ".claude.json"), '{"token":"secret-private-token')
  for (const template of ["codex", "claude-code"] as const) {
    const result = await discoverProviderWorkspaces(input(template), f.dependencies)
    assert.equal(result.candidates.length, 0)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /Could not parse/u)
    assert.doesNotMatch(JSON.stringify(result), /secret-private-token/u)
  }
})

test("invalid project maps and unreadable configuration report safe warnings", async t => {
  const f = await fixture(t)
  const source = join(f.home, ".claude.json")
  await writeFile(source, '{"projects": ["private-value"]}')
  const invalid = await discoverProviderWorkspaces(input("claude-code"), f.dependencies)
  assert.equal(invalid.warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(invalid), /private-value/u)
  await rm(source)
  await mkdir(source)
  const unreadable = await discoverProviderWorkspaces(input("claude-code"), f.dependencies)
  assert.deepEqual(unreadable, { supported: true, candidates: [], warnings: ["Could not read .claude.json to discover workspaces."] })
})

test("unsupported providers do not load shell environment; shell errors never expose startup output", async () => {
  const dependencies = { env: {}, home: "/unused", shellEnvironment: async () => { throw new Error("private-shell-output") } }
  assert.deepEqual(await discoverProviderWorkspaces(input("acp", { inheritShellEnvironment: true }), dependencies), {
    supported: false, candidates: [], warnings: [],
  })
  const result = await discoverProviderWorkspaces(input("codex", { inheritShellEnvironment: true }), dependencies)
  assert.deepEqual(result, { supported: true, candidates: [], warnings: ["Could not load the Agent's shell environment to discover workspaces."] })
})
