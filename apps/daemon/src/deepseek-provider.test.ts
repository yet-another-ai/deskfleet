import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { configureDshRuntime, sourceDshRuntime } from "@deskfleet/dsh-runtime"
import { AgentProviders } from "./agent-providers.ts"
import { configureExternalDeepSeekHarness, deepseekHarnessEnvironment, deepseekHarnessProcess } from "@deskfleet/agent-deepseek-harness"
import { probeProvider } from "./provider-setup.ts"

test("bundled DeepSeek provider loads the session workspace dotenv before ACP initialization", { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-deepseek-workspace-"))
  const daemon = join(directory, "daemon")
  const workspace = join(directory, "workspace")
  const home = join(directory, "home")
  const credentials = join(directory, "credentials.yaml")
  const guard = join(directory, "offline.mjs")
  const previousCwd = process.cwd()
  const runtime = sourceDshRuntime(import.meta.url)
  t.after(async () => {
    process.chdir(previousCwd)
    configureDshRuntime(runtime)
    await rm(directory, { recursive: true, force: true })
  })
  await Promise.all([daemon, workspace, home].map(path => mkdir(path)))
  await writeFile(join(workspace, ".env"), "DEEPSEEK_API_KEY=fixture-workspace-secret\n")
  await writeFile(credentials, JSON.stringify({ version: 1, refs: {}, records: {
    "deepseek-account-platform/default": { kind: "grant", payload: {
      version: 1, issuer: "https://platform.deepseek.com", token: "fixture-account-token",
    } },
  } }), { mode: 0o600 })
  await writeFile(guard, `
    import { Socket } from 'node:net';
    Socket.prototype.connect = function () { throw new Error('Network is disabled in this fixture'); };
    globalThis.fetch = async () => new Response('{}', { status: 503 });
  `)
  configureDshRuntime({ ...runtime, args: ["--import", pathToFileURL(guard).href] })
  // The daemon and worktree deliberately have different directories. Going through
  // the provider must pass cwd before the helper selects its credential route.
  process.chdir(daemon)
  // The OS may resolve symlinks in cwd, such as macOS /var -> /private/var.
  const daemonCwd = process.cwd()
  const registry = new AgentProviders(daemon)
  await registry.init()
  const record = await registry.create({ template: "deepseek-harness", name: "DeepSeek", env: {
    PATH: "", NODE_OPTIONS: "", NODE_PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    DSH_HOME: join(home, "harness"), DSH_AGENTS_HOME: join(home, "agents"),
    DESKFLEET_DSH_CREDENTIALS_PATH: credentials, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DSH_TELEMETRY_MODE: "DISABLED", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "",
  } })
  const { provider, config } = registry.resolve(record.id)
  const launch = { ...config, cwd: workspace }
  const connection = await provider.connect(launch, { onUpdate() {}, signal: t.signal })
  try {
    const session = await connection.newSession({ cwd: workspace, mcpServers: [] })
    const model = session.configOptions?.find(option => option.id === "model")
    assert.ok(model && model.type === "select")
    assert.equal(JSON.parse(model.currentValue)[0], "deepseek-official", "the workspace key must override the stored account")
    assert.equal(process.cwd(), daemonCwd, "provider startup must not change the daemon's working directory")
    assert.equal(registry.get(record.id).env.DEEPSEEK_API_KEY, "", "workspace credentials stay in the child process")
  } finally { await connection.close() }
})

test("an explicit DeepSeek executable starts in the session worktree", async () => {
  const config = { name: "External", binaryPath: "/tools/dsh", cwd: "/workspace", env: {} }
  assert.deepEqual(await deepseekHarnessProcess(config), { command: "/tools/dsh", args: ["--profile", "acp"], env: {}, cwd: "/workspace" })
})

test("headless DeepSeek discovers the installed Desktop launchers and scopes the default Harness home", async t => {
  configureExternalDeepSeekHarness()
  t.after(() => configureExternalDeepSeekHarness(false))

  const registration = join("registration", "team")
  assert.deepEqual(deepseekHarnessEnvironment({ env: {} }, registration), { DSH_HOME: join(registration, "deepseek-harness") })
  assert.deepEqual(deepseekHarnessEnvironment({ binaryPath: "/custom/dsh", env: {} }, registration), {})
  assert.deepEqual(deepseekHarnessEnvironment({ env: { DSH_HOME: "/custom/home" } }, registration), { DSH_HOME: "/custom/home" })

  const input = { template: "deepseek-harness" as const, name: "DeepSeek", inheritShellEnvironment: false, env: {} }
  for (const [platform, arch, home, launcher, pathLauncher] of [
    ["darwin", "arm64", "/Users/operator", "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh", "/tools/dsh"],
    ["win32", "x64", "C:\\Users\\operator", "C:\\Agent Tools\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd", "C:\\Tools\\dsh.cmd"],
  ] as const) {
    const probe = await probeProvider(input, {
      platform, arch, home, cwd: home,
      env: { PATH: platform === "win32" ? "C:\\Tools" : "/tools" },
      executable: async path => path === launcher || path === pathLauncher,
      run: async (command, args) => {
        if (command.endsWith("powershell.exe")) {
          assert.match(args.join(" "), /InstallLocation/u)
          return { code: 0, stdout: "C:\\Agent Tools\\DeepSeek Harness\r\n", stderr: "" }
        }
        assert.equal(command, launcher, "prefer the official Desktop launcher to a command on PATH")
        return { code: 0, stdout: args[0] === "--version" ? "0.2.2-rc.5" : "Usage: dsh", stderr: "" }
      },
    })
    assert.equal(probe.status, "found")
    assert.equal(probe.binaryPath, undefined, "keep discovered launchers as the scoped default when saving settings")
    assert.equal(probe.loginAvailable, false)
    assert.equal(probe.version, "0.2.2-rc.5")
  }
  const missing = await probeProvider(input, { platform: "linux", env: { PATH: "" }, executable: async () => false })
  assert.equal(missing.status, "missing")
  assert.match(missing.installMessage ?? "", /npm install -g @deepseek-ai\/dsh@0\.2\.2-rc\.5/u)

  const fallback = await probeProvider(input, {
    platform: "darwin", arch: "arm64", home: "/Users/operator", cwd: "/Users/operator",
    env: { PATH: "/tools" }, executable: async path => path.startsWith("/Applications/") || path === "/tools/dsh",
    run: async command => ({ code: command === "/tools/dsh" ? 0 : 1, stdout: "dsh 0.2.2-rc.5", stderr: "" }),
  })
  assert.equal(fallback.status, "found", "an unusable Desktop launcher must not mask a working dsh on PATH")
  assert.equal(fallback.version, "dsh 0.2.2-rc.5")
})
