import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { AgentProviderInput } from "./provider-protocol.ts"
import { launchProviderCommand, runProbeCommand, type ProbeCommand, type ProbeCommandResult } from "./provider-setup-process.ts"
import { probeProvider, ProviderSetup } from "./provider-setup.ts"
import type { TerminalRun } from "./terminals.ts"

const input = (template: AgentProviderInput["template"], overrides: Partial<AgentProviderInput> = {}): AgentProviderInput => ({
  template, name: template, env: {}, ...overrides,
})
const result = (stdout: string, code = 0): ProbeCommandResult => ({ stdout, stderr: "", code })

function fixture(options: {
  files?: string[]; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv
  answer?: ProbeCommand
} = {}) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  const runs: TerminalRun[] = []
  const dependencies = {
    platform: options.platform ?? "linux" as NodeJS.Platform,
    arch: "x64", env: options.env ?? { PATH: "/tools" }, home: options.platform === "win32" ? "C:\\Users\\someone" : "/home/someone", cwd: "/working",
    executable: async (path: string) => (options.files ?? []).includes(path),
    run: (async (command, args, env, cwd) => {
      calls.push({ command, args, env, cwd })
      return options.answer ? options.answer(command, args, env, cwd) : result("codex-cli 1.2.3")
    }) as ProbeCommand,
  }
  const terminals = { run: async (run: TerminalRun) => {
    runs.push(run)
    return { id: run.terminalId, title: run.title, cwd: run.cwd!, cols: run.cols, rows: run.rows, status: "running" as const }
  } }
  return { calls, runs, dependencies, setup: new ProviderSetup(terminals, dependencies) }
}

test("missing binary probe never starts ACP, login, or an installer", async () => {
  const f = fixture({ files: ["/bin/bash"] })
  assert.deepEqual(await f.setup.probe(input("codex")), {
    status: "missing", auth: "unknown", installable: true, loginAvailable: false,
  })
  assert.equal(f.calls.length, 0)
  assert.equal(f.runs.length, 0)
})

test("explicit missing binary is not replaced by a different installed executable", async () => {
  const f = fixture({ files: ["/tools/codex", "/bin/bash"] })
  assert.equal((await f.setup.probe(input("codex", { binaryPath: "/missing/codex" }))).status, "missing")
  assert.equal(f.calls.length, 0)
})

test("probe resolves the merged PATH and reports only version and auth state", async () => {
  const f = fixture({ files: ["/override/codex", "/tools/codex", "/bin/bash"], answer: async (_command, args) =>
    args[0] === "--version" ? result("codex-cli 1.2.3") : { stdout: "", stderr: "Logged in using ChatGPT", code: 0 } })
  const value = await f.setup.probe(input("codex", { env: { PATH: "/override", CODEX_HOME: "/account" } }))
  assert.deepEqual(value, { status: "found", binaryPath: "/override/codex", version: "codex-cli 1.2.3", auth: "authenticated", installable: true, loginAvailable: true })
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["login", "status"]])
  assert.equal(f.calls[1]!.env.CODEX_HOME, "/account")
  assert.equal(f.calls[1]!.cwd, "/home/someone")
})

test("probe also finds an official user install outside the daemon PATH", async () => {
  const f = fixture({ files: ["/home/someone/.local/bin/codex", "/bin/bash"], answer: async (_command, args) =>
    args[0] === "--version" ? result("codex-cli 1.2.3") : result("Not logged in", 1) })
  const value = await probeProvider(input("codex"), f.dependencies)
  assert.equal(value.binaryPath, "/home/someone/.local/bin/codex")
  assert.equal(value.auth, "unauthenticated")
})

test("Cursor prefers its unique alias and validates its bare version with help", async () => {
  const f = fixture({ files: ["/tools/agent", "/home/someone/.local/bin/cursor-agent", "/bin/bash"], answer: async (_command, args) =>
    args[0] === "--version" ? result("2026.10.22-build") : args[0] === "--help" ? result("Start the Cursor Agent")
      : result(JSON.stringify({ isAuthenticated: true, userInfo: { email: "private@example.test" } })) })
  const value = await f.setup.probe(input("cursor"))
  assert.equal(value.binaryPath, "/home/someone/.local/bin/cursor-agent")
  assert.equal(value.auth, "authenticated")
  assert.ok(!JSON.stringify(value).includes("private@example.test"))
  assert.ok(f.calls.every(call => call.command.endsWith("cursor-agent")))
})

test("Cursor does not mistake Grok's agent alias for Cursor", async () => {
  const f = fixture({ files: ["/tools/agent", "/bin/bash"], answer: async () => result("Grok 1.2.3") })
  const value = await f.setup.probe(input("cursor"))
  assert.equal(value.status, "invalid")
  assert.equal(value.loginAvailable, false)
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
})

test("unrecognized or failed auth status stays unknown", async () => {
  const f = fixture({ files: ["/tools/claude", "/bin/bash"], answer: async (_command, args) =>
    args[0] === "--version" ? result("2.1.200 (Claude Code)") : result("Unknown command", 1) })
  assert.equal((await f.setup.probe(input("claude-code"))).auth, "unknown")
})

test("Claude reports account absence separately from external backend credentials", async () => {
  for (const [payload, expected] of [
    [{ loggedIn: false }, "unauthenticated"],
    [{ loggedIn: true }, "authenticated"],
    [{ loggedIn: false, apiKeySource: "env" }, "authenticated"],
    [{ loggedIn: false, apiProvider: "bedrock" }, "unknown"],
  ] as const) {
    const f = fixture({ files: ["/tools/claude"], answer: async (_command, args) =>
      args[0] === "--version" ? result("2.1.200 (Claude Code)") : result(JSON.stringify(payload)) })
    assert.equal((await f.setup.probe(input("claude-code"))).auth, expected)
  }
})

test("Grok cached-token status is unknown without starting an auth flow", async () => {
  const f = fixture({ files: ["/home/someone/.grok/bin/grok"], answer: async () => result("grok 0.1.0") })
  assert.equal((await f.setup.probe(input("grok"))).auth, "unknown")
  assert.deepEqual(f.calls.map(call => call.args), [["--version"]])
  assert.equal((await f.setup.probe(input("grok", { env: { XAI_API_KEY: "configured-key" } }))).auth, "unknown")
})

test("Pi validates its bare version with help and leaves authentication unknown", async () => {
  const f = fixture({ files: ["/home/someone/.pi/agent/bin/pi", "/bin/bash"], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
  assert.deepEqual(await f.setup.probe(input("pi", { env: { ANTHROPIC_API_KEY: "configured-key" } })), {
    status: "found", binaryPath: "/home/someone/.pi/agent/bin/pi", version: "1.4.0", auth: "unknown", installable: true, loginAvailable: true,
  })
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
})

test("Pi rejects an unrelated executable with a bare version", async () => {
  const f = fixture({ files: ["/tools/pi"], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - calculate digits of pi") })
  const value = await f.setup.probe(input("pi"))
  assert.equal(value.status, "invalid")
  assert.equal(value.loginAvailable, false)
})

test("Pi discovers configured managed installs and npm global prefixes", async () => {
  for (const [platform, env, binary] of [
    ["linux", { PATH: "", PI_CODING_AGENT_DIR: "/custom/pi-agent" }, "/custom/pi-agent/bin/pi"],
    ["linux", { PATH: "", NPM_CONFIG_PREFIX: "/custom/npm" }, "/custom/npm/bin/pi"],
    ["win32", { PATH: "", PI_CODING_AGENT_DIR: "C:\\Pi Agent" }, "C:\\Pi Agent\\bin\\pi.cmd"],
    ["win32", { PATH: "", APPDATA: "C:\\Roaming" }, "C:\\Roaming\\npm\\pi.cmd"],
    ["win32", { PATH: "", NPM_CONFIG_PREFIX: "C:\\npm-prefix" }, "C:\\npm-prefix\\pi.cmd"],
  ] as const) {
    const f = fixture({ platform, env, files: [binary], answer: async (_command, args) =>
      args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
    assert.equal((await f.setup.probe(input("pi"))).binaryPath, binary)
  }
})

test("custom ACP probe checks presence without invoking unsupported CLI metadata commands", async () => {
  const f = fixture({ files: ["/tools/custom"] })
  const value = await f.setup.probe(input("acp", { binaryPath: "custom" }))
  assert.equal(value.status, "found")
  assert.equal(value.installable, false)
  assert.equal(value.loginAvailable, false)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.setup.install(input("acp")), /install yourself/u)
  await assert.rejects(f.setup.login(input("acp")), /custom ACP/u)
})

test("official installers start dedicated terminals and do not start login or ACP", async () => {
  for (const [template, url] of [
    ["codex", "https://chatgpt.com/codex/install.sh"], ["claude-code", "https://claude.ai/install.sh"],
    ["cursor", "https://cursor.com/install"], ["grok", "https://x.ai/cli/install.sh"], ["pi", "https://pi.dev/install.sh"],
  ] as const) {
    const f = fixture({ files: ["/bin/bash"] })
    const terminal = await f.setup.install(input(template, { binaryPath: "/missing/old", env: { TOKEN: "sensitive-value" } }))
    assert.equal(terminal.status, "running")
    assert.equal(f.calls.length, 0)
    assert.equal(f.runs[0]!.command, "/bin/bash")
    assert.ok(f.runs[0]!.args?.join(" ").includes(url))
    assert.ok(!f.runs[0]!.args?.join(" ").includes("sensitive-value"))
    assert.equal(f.runs[0]!.env?.TOKEN, "sensitive-value")
  }
})

test("login launches only the selected provider's dedicated login command", async () => {
  for (const [template, executable, version, expected] of [
    ["codex", "codex", "codex-cli 1.2.3", ["login", "--device-auth"]],
    ["claude-code", "claude", "2.1.200 (Claude Code)", ["auth", "login"]],
    ["cursor", "cursor-agent", "Cursor 2026.10.22", ["login"]],
    ["grok", "grok", "grok 0.1.0", ["login", "--device-auth"]],
  ] as const) {
    const f = fixture({ files: [`/tools/${executable}`], answer: async () => result(version) })
    await f.setup.login(input(template))
    assert.equal(f.runs[0]!.command, `/tools/${executable}`)
    assert.deepEqual(f.runs[0]!.args, [...expected])
    if (template === "cursor") assert.equal(f.runs[0]!.env?.NO_OPEN_BROWSER, "1")
    assert.ok(f.calls.every(call => !call.args.includes("acp")))
  }
})

test("login rejects a missing executable without spawning a terminal", async () => {
  const f = fixture()
  await assert.rejects(f.setup.login(input("codex")), /before signing in/u)
  assert.equal(f.runs.length, 0)
})

test("Pi sign in opens its interactive CLI without sending a slash command as a prompt", async () => {
  const f = fixture({ files: ["/tools/pi"], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
  await f.setup.login(input("pi", { env: { PI_CODING_AGENT_DIR: "/custom/pi-agent" } }))
  assert.equal(f.runs[0]!.command, "/tools/pi")
  assert.deepEqual(f.runs[0]!.args, [])
  assert.equal(f.runs[0]!.env?.PI_CODING_AGENT_DIR, "/custom/pi-agent")
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
})

test("Pi Windows setup uses the native installer and safely launches its managed shim", async () => {
  const directory = "C:\\User's $tools\\pi-agent"
  const binary = `${directory}\\bin\\pi.cmd`
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const f = fixture({ platform: "win32", env: { PATH: "" }, files: [binary, powershell], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
  const provider = input("pi", { env: { PI_CODING_AGENT_DIR: directory, TOKEN: "sensitive-value" } })
  await f.setup.install(provider)
  assert.equal(f.runs[0]!.command, powershell)
  assert.match(f.runs[0]!.args!.at(-1)!, /https:\/\/pi\.dev\/install\.ps1/u)
  assert.equal(f.runs[0]!.env?.PI_CODING_AGENT_DIR, directory)
  assert.equal(f.runs[0]!.env?.TOKEN, "sensitive-value")
  assert.ok(!f.runs[0]!.args!.join(" ").includes("sensitive-value"))
  await f.setup.login(provider)
  assert.equal(f.runs[1]!.command, powershell)
  assert.equal(f.runs[1]!.env?.DESKFLEET_PROVIDER_COMMAND, binary)
  assert.equal(f.runs[1]!.env?.PI_CODING_AGENT_DIR, directory)
  assert.ok(!f.runs[1]!.args!.join(" ").includes(binary))
  assert.equal(f.runs[1]!.args!.at(-1), "& $env:DESKFLEET_PROVIDER_COMMAND ; exit $LASTEXITCODE")
})

test("Windows uses case-insensitive environment overrides and official install locations", async () => {
  const f = fixture({ platform: "win32", env: { Path: "C:\\original", LOCALAPPDATA: "C:\\Local" },
    files: ["C:\\override\\codex.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
    answer: async (_command, args) => args[0] === "--version" ? result("codex-cli 1.2.3") : result("Not logged in", 1) })
  const value = await f.setup.probe(input("codex", { env: { PATH: "C:\\override" } }))
  assert.equal(value.binaryPath, "C:\\override\\codex.exe")
  assert.equal(value.installable, true)
  assert.equal(f.calls[0]!.env.PATH, "C:\\override")
  assert.equal(f.calls[0]!.env.Path, undefined)
  await f.setup.install(input("codex"))
  assert.ok(f.runs[0]!.args?.join(" ").includes("https://chatgpt.com/codex/install.ps1"))
})

test("Windows Grok requires Git Bash and never uses the WSL bash launcher", async () => {
  const f = fixture({ platform: "win32", env: { PATH: "C:\\Windows\\System32" }, files: ["C:\\Windows\\System32\\bash.exe"] })
  const value = await f.setup.probe(input("grok"))
  assert.equal(value.installable, false)
  assert.match(value.installMessage!, /Git for Windows/u)
  await assert.rejects(f.setup.install(input("grok")), /Git for Windows/u)
})

test("Windows adapters reject shell shims they cannot directly execute", async () => {
  for (const [template, command] of [["codex", "codex"], ["claude-code", "claude"]] as const) {
    const f = fixture({ platform: "win32", env: { PATH: "C:\\tools" }, files: [`C:\\tools\\${command}.cmd`] })
    const value = await f.setup.probe(input(template))
    assert.equal(value.status, "invalid")
    assert.match(value.message!, /native \.exe/u)
    assert.equal(f.calls.length, 0)
  }
})

test("Pi Windows discovery skips PowerShell shims its ACP adapter cannot execute", async () => {
  const f = fixture({ platform: "win32", env: { PATH: "C:\\tools" }, files: ["C:\\tools\\pi.ps1", "C:\\tools\\pi.cmd"],
    answer: async (_command, args) => args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
  assert.equal((await f.setup.probe(input("pi"))).binaryPath, "C:\\tools\\pi.cmd")
  assert.ok(f.calls.every(call => call.command === "C:\\tools\\pi.cmd"))
  const value = await f.setup.probe(input("pi", { binaryPath: "C:\\tools\\pi.ps1" }))
  assert.equal(value.status, "invalid")
  assert.equal(value.loginAvailable, false)
  assert.match(value.message!, /Select Pi's \.cmd launcher/u)
  assert.equal(f.calls.length, 2)
})

test("one deadline bounds a probe across slow candidates and aborts metadata work", async () => {
  let signal: AbortSignal | undefined
  const f = fixture({ files: ["/tools/codex"] })
  await assert.rejects(probeProvider(input("codex"), {
    ...f.dependencies, timeoutMs: 10,
    run: (_command, _args, _env, _cwd, value) => { signal = value; return new Promise(() => {}) },
  }), /detection timed out/u)
  assert.equal(signal?.aborted, true)
})

test("Windows launcher paths remain data and argument quoting preserves shell metacharacters", () => {
  const command = "C:\\CLI's $folder\\cursor-agent.cmd"
  const launch = launchProviderCommand(command, ["acp", "a'b;$value"], { PATH: "C:\\tools" }, "win32")
  assert.equal(launch.env!.DESKFLEET_PROVIDER_COMMAND, command)
  assert.ok(!launch.args!.join(" ").includes(command))
  assert.ok(launch.args!.at(-1)!.includes("'a''b;$value'"))
  assert.equal(launch.env!.PATH, "C:\\tools")
})

test("real executable discovery checks files and executable permissions", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "df-provider-probe-"))
  try {
    const binary = join(directory, "custom-acp")
    await mkdir(join(directory, "not-a-file"))
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    const dependencies = { platform: process.platform, env: { PATH: directory }, home: directory }
    assert.equal((await probeProvider(input("acp", { binaryPath: "custom-acp" }), dependencies)).binaryPath, binary)
    assert.equal((await probeProvider(input("acp", { binaryPath: join(directory, "not-a-file") }), dependencies)).status, "missing")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("metadata runner closes stdin and preserves nonzero status for auth probes", async () => {
  const value = await runProbeCommand(process.execPath, ["-e", "process.stdin.on('end',()=>{process.stdout.write('not logged in');process.exitCode=1});process.stdin.resume()"], process.env, process.cwd())
  assert.equal(value.code, 1)
  assert.equal(value.stdout, "not logged in")
})
