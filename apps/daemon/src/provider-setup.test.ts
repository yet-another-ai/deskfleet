import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import { bundledDshRuntime, configureDshRuntime, electronDshHost, sourceDshRuntime } from "@deskfleet/dsh-runtime"
import { createTerminal } from "@deskfleet/native"
import type { AgentProviderInput } from "./provider-protocol.ts"
import { interactiveProviderProcess, launchProviderCommand, runProbeCommand, type ProbeCommand, type ProbeCommandResult } from "./provider-setup-process.ts"
import { probeProvider, ProviderSetup } from "./provider-setup.ts"
import type { TerminalRun } from "./terminals.ts"

const input = (template: AgentProviderInput["template"], overrides: Partial<AgentProviderInput> = {}): AgentProviderInput => ({
  template, name: template, inheritShellEnvironment: false, env: {}, ...overrides,
})
const result = (stdout: string, code = 0): ProbeCommandResult => ({ stdout, stderr: "", code })

function fixture(options: {
  files?: string[]; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv
  directory?: string
  answer?: ProbeCommand
  shellEnvironment?: () => Promise<Record<string, string>>
} = {}) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  const runs: TerminalRun[] = []
  const dependencies = {
    directory: options.directory,
    shellEnvironment: options.shellEnvironment,
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

test("provider setup uses the shell environment with manual overrides for detection, login, and installation", async () => {
  const f = fixture({ files: ["/shell/codex", "/bin/bash"],
    shellEnvironment: async () => ({ PATH: "/shell", ACCOUNT: "shell", SHELL_ONLY: "present" }),
    answer: async (_command, args) => args[0] === "--version" ? result("codex-cli 1.2.3") : result("Logged in using ChatGPT"),
  })
  const provider = input("codex", { inheritShellEnvironment: true, env: { ACCOUNT: "manual", EXTRA: "added" } })
  assert.equal((await f.setup.probe(provider)).binaryPath, "/shell/codex")
  assert.equal(f.calls[0]!.env.ACCOUNT, "manual")
  assert.equal(f.calls[0]!.env.SHELL_ONLY, "present")
  await f.setup.login(provider)
  assert.equal(f.runs[0]!.env?.PATH, "/shell")
  assert.equal(f.runs[0]!.env?.ACCOUNT, "manual")
  assert.equal(f.runs[0]!.env?.EXTRA, "added")
  await f.setup.install(provider)
  assert.equal(f.runs[1]!.env?.PATH, "/shell")
  assert.equal(f.runs[1]!.env?.ACCOUNT, "manual")
})

test("provider setup defaults to shell environment only on supported platforms", async () => {
  let loads = 0
  const unix = fixture({ files: ["/shell/codex", "/bin/bash"], shellEnvironment: async () => { loads++; return { PATH: "/shell" } } })
  const provider = input("codex", { inheritShellEnvironment: undefined })
  assert.equal((await unix.setup.probe(provider)).binaryPath, "/shell/codex")
  assert.equal(loads, 1)
  const windows = fixture({ platform: "win32", shellEnvironment: async () => { loads++; return {} } })
  await windows.setup.probe(provider)
  assert.equal(loads, 1)
})

test("shell startup has a separate budget from provider detection", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture({
    files: ["/shell/codex", "/bin/bash"],
    shellEnvironment: () => new Promise(resolve => setTimeout(() => resolve({ PATH: "/shell" }), 4_500)),
    answer: (_command, args) => new Promise(resolve => setTimeout(() => resolve(
      args[0] === "--version" ? result("codex-cli 1.2.3") : result("Logged in using ChatGPT"),
    ), 2_900)),
  })
  const pending = f.setup.probe(input("codex", { inheritShellEnvironment: true }))
  const checked = assert.doesNotReject(async () => {
    const found = await pending
    assert.equal(found.status, "found")
    assert.equal(found.binaryPath, "/shell/codex")
    assert.equal(found.auth, "authenticated")
  })
  await nextTurn()
  context.mock.timers.tick(4_500)
  await nextTurn()
  context.mock.timers.tick(2_900)
  await nextTurn()
  context.mock.timers.tick(2_900)
  await checked
})

test("the extended detection deadline still aborts shell startup", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let signal: AbortSignal | undefined
  const pending = probeProvider(input("codex", { inheritShellEnvironment: true }), {
    shellEnvironment: value => { signal = value; return new Promise(() => {}) },
  })
  const checked = assert.rejects(pending, /detection timed out/u)
  context.mock.timers.tick(15_000)
  await checked
  assert.equal(signal?.aborted, true)
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

test("OMP discovers native and Bun installs and leaves model-provider authentication unknown", async () => {
  for (const [platform, env, binary, shell] of [
    ["linux", { PATH: "" }, "/home/someone/.local/bin/omp", "/bin/bash"],
    ["darwin", { PATH: "" }, "/home/someone/.bun/bin/omp", "/bin/bash"],
    ["linux", { PATH: "", BUN_INSTALL: "/custom/bun" }, "/custom/bun/bin/omp", "/bin/bash"],
    ["linux", { PATH: "", PI_INSTALL_DIR: "/custom/omp" }, "/custom/omp/omp", "/bin/bash"],
    ["win32", { PATH: "C:\\tools", LOCALAPPDATA: "C:\\Local" }, "C:\\Local\\omp\\omp.exe", "C:\\tools\\pwsh.exe"],
    ["win32", { PATH: "C:\\tools" }, "C:\\Users\\someone\\.bun\\bin\\omp.exe", "C:\\tools\\pwsh.exe"],
    ["win32", { PATH: "C:\\tools", BUN_INSTALL: "C:\\Bun" }, "C:\\Bun\\bin\\omp.cmd", "C:\\tools\\pwsh.exe"],
    ["win32", { PATH: "C:\\tools", PI_INSTALL_DIR: "C:\\OMP" }, "C:\\OMP\\omp.exe", "C:\\tools\\pwsh.exe"],
  ] as const) {
    const f = fixture({ platform, env, files: [binary, shell], answer: async (_command, args) =>
      args[0] === "--version" ? result("18.13.1") : result("Usage: omp <command> [options]") })
    assert.deepEqual(await f.setup.probe(input("omp", { env: { ANTHROPIC_API_KEY: "configured-key" } })), {
      status: "found", binaryPath: binary, version: "18.13.1", auth: "unknown", installable: true, loginAvailable: true,
    })
    assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
    assert.equal(f.runs.length, 0)
  }
})

test("OMP rejects a different provider with a bare version", async () => {
  const f = fixture({ files: ["/tools/omp"], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - AI coding assistant with read, bash, edit, write tools") })
  const value = await f.setup.probe(input("omp"))
  assert.equal(value.status, "invalid")
  assert.equal(value.loginAvailable, false)
})

test("bundled DeepSeek Harness is available without PATH, npm, or a persisted executable path", async () => {
  const f = fixture({ env: { PATH: "" }, answer: async (_command, args, env) => args.includes("status")
    ? result(JSON.stringify({ auth: env.DEEPSEEK_API_KEY ? "authenticated" : "unauthenticated" })) : result("0.2.2-rc.1") })
  const found = await f.setup.probe(input("deepseek-harness"))
  assert.equal(found.status, "found")
  assert.equal(found.binaryPath, undefined)
  assert.equal(found.version, "0.2.2-rc.1")
  assert.equal(found.installable, false)
  assert.equal(found.loginAvailable, true)
  assert.equal(found.auth, "unauthenticated")
  assert.equal(f.calls[0]!.args.at(-1), "--version")
  assert.match(f.calls[0]!.args[0]!, /dsh[/\\]lib[/\\]bin\.js$/u)
  assert.equal(f.runs.length, 0)
  assert.equal((await f.setup.probe(input("deepseek-harness", { env: { DEEPSEEK_API_KEY: "secret" } }))).auth, "authenticated")
})

test("missing bundled DeepSeek runtime reports repair without offering npm installation", async () => {
  const f = fixture({ answer: async () => { throw Object.assign(new Error("missing runtime"), { code: "ENOENT" }) } })
  const found = await f.setup.probe(input("deepseek-harness"))
  assert.equal(found.status, "missing")
  assert.equal(found.installable, false)
  assert.match(found.installMessage!, /Reinstall DeskFleet/u)
})

test("bundled DeepSeek metadata uses the embedding host environment", async context => {
  configureDshRuntime(bundledDshRuntime("/resources/dsh", electronDshHost("/desktop/electron")))
  context.after(() => configureDshRuntime(sourceDshRuntime(import.meta.url)))
  const f = fixture({ env: { PATH: "" }, answer: async (_command, args) => args.includes("status")
    ? result(JSON.stringify({ auth: "authenticated", method: "account" })) : result("0.2.2-rc.1") })
  const found = await f.setup.probe(input("deepseek-harness", {
    env: { DEEPSEEK_API_KEY: "configured-key", ELECTRON_RUN_AS_NODE: "0" },
  }))
  assert.equal(found.status, "found")
  assert.equal(found.auth, "authenticated")
  assert.equal(found.binaryPath, undefined)
  assert.equal(f.calls[0]!.command, "/desktop/electron")
  assert.equal(f.calls[0]!.args[0], "--expose-internals")
  assert.equal(f.calls[0]!.env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(f.calls[0]!.env.DEEPSEEK_API_KEY, "configured-key")
  assert.equal(f.calls[1]!.command, "/desktop/electron")
  assert.equal(f.calls[1]!.env.ELECTRON_RUN_AS_NODE, "1")
})

test("failed DeepSeek credential detection leaves sign-in available and never exposes helper output", async () => {
  for (const response of [result("private diagnostic", 1), result("not JSON"), result(JSON.stringify({ auth: "private-value" }))]) {
    const f = fixture({ answer: async (_command, args) => args.includes("status") ? response : result("0.2.2-rc.1") })
    const found = await f.setup.probe(input("deepseek-harness"))
    assert.equal(found.status, "found")
    assert.equal(found.auth, "unknown")
    assert.equal(found.loginAvailable, true)
    assert.ok(!JSON.stringify(found).includes("private"))
    assert.equal(f.runs.length, 0)
  }
})

test("bundled DeepSeek metadata can complete after the external CLI timeout", { timeout: 15_000 }, async () => {
  const value = await probeProvider(input("deepseek-harness"), {
    env: process.env, home: process.cwd(),
    run: (_command, _args, env, cwd, signal, timeoutMs) => {
      assert.equal(timeoutMs, 30_000)
      return runProbeCommand(process.execPath, ["-e", "setTimeout(()=>console.log('0.2.2-rc.1'), 3_200)"], env, cwd, signal, timeoutMs)
    },
  })
  assert.equal(value.status, "found")
  assert.equal(value.version, "0.2.2-rc.1")
})

test("slow bundled DeepSeek metadata and credentials fit within one detection deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = probeProvider(input("deepseek-harness"), {
    run: (_command, args) => new Promise(resolve => {
      setTimeout(() => resolve(args.includes("status")
        ? result(JSON.stringify({ auth: "unauthenticated" })) : result("0.2.2-rc.1")), 20_000)
    }),
  })
  // Attach the assertion before advancing the clock so a deadline rejection is observed.
  const checked = assert.doesNotReject(async () => {
    const found = await pending
    assert.equal(found.status, "found")
    assert.equal(found.version, "0.2.2-rc.1")
    assert.equal(found.auth, "unauthenticated")
    assert.equal(found.loginAvailable, true)
  })
  await nextTurn()
  context.mock.timers.tick(20_000)
  await nextTurn()
  context.mock.timers.tick(10_000)
  await checked
})

test("bundled DeepSeek spawn failures surface as probe errors instead of missing installations", async () => {
  for (const error of [Object.assign(new Error("metadata timed out"), { killed: true }), Object.assign(new Error("permission denied"), { code: "EACCES" })]) {
    const f = fixture({ answer: async () => { throw error } })
    await assert.rejects(f.setup.probe(input("deepseek-harness")), value => value === error)
  }
  const f = fixture({ answer: async () => result("", 1) })
  assert.equal((await f.setup.probe(input("deepseek-harness"))).status, "invalid")
})

test("bundled DeepSeek deadline cancels detection without reporting a missing runtime", async () => {
  const signals: (AbortSignal | undefined)[] = []
  await assert.rejects(probeProvider(input("deepseek-harness"), {
    timeoutMs: 10,
    run: (_command, _args, _env, _cwd, signal) => { signals.push(signal); return new Promise(() => {}) },
  }), /detection timed out/u)
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal?.aborted))
})

test("DeepSeek Harness still validates explicit executable overrides", async () => {
  const f = fixture({ files: ["/tools/dsh"], answer: async (_command, args) =>
    args[0] === "--version" ? result("0.2.1-rc.2") : result("dsh: boot a DeepSeek Harness profile") })
  const found = await f.setup.probe(input("deepseek-harness", { binaryPath: "/tools/dsh" }))
  assert.equal(found.status, "found")
  assert.equal(found.binaryPath, "/tools/dsh")
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
  assert.equal((await f.setup.probe(input("deepseek-harness", { binaryPath: "/missing/dsh" }))).status, "missing")
})

test("Pi rejects an unrelated executable with a bare version", async () => {
  const f = fixture({ files: ["/tools/pi"], answer: async (_command, args) =>
    args[0] === "--version" ? result("1.4.0") : result("pi - calculate digits of pi") })
  const value = await f.setup.probe(input("pi"))
  assert.equal(value.status, "invalid")
  assert.equal(value.loginAvailable, false)
})

test("Antigravity discovers official CLI locations, migrates legacy server paths, and validates bare versions with help output", async () => {
  for (const [platform, env, binary, shell, legacyPath] of [
    ["linux", { PATH: "" }, "/home/someone/.local/bin/agy", "/bin/bash", "/home/someone/.local/share/deskfleet/providers/antigravity/agy_acp_server.par"],
    ["darwin", { PATH: "" }, "/home/someone/.local/bin/agy", "/bin/bash", "/Users/someone/.local/share/deskfleet/providers/antigravity/agy_acp_server.par"],
    ["win32", { PATH: "C:\\tools", LOCALAPPDATA: "C:\\Local" }, "C:\\Local\\agy\\bin\\agy.exe", "C:\\tools\\pwsh.exe", "C:\\Local\\deskfleet\\providers\\antigravity\\agy_acp_server.exe"],
  ] as const) {
    const f = fixture({ platform, env, files: [binary, shell], answer: async (_command, args) =>
      args[0] === "--version" ? result("1.5.3") : result("Usage of agy:\n  acp  Start the Agent Client Protocol (ACP) stdio server") })
    assert.deepEqual(await f.setup.probe(input("antigravity", { binaryPath: legacyPath })), {
      status: "found", binaryPath: binary, version: "1.5.3", auth: "unknown", installable: true, loginAvailable: true,
    })
    assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
    await f.setup.install(input("antigravity", { binaryPath: legacyPath }))
    assert.equal(f.runs[0]!.command, shell)
    assert.match(f.runs[0]!.args!.at(-1)!, /https:\/\/antigravity\.google\/cli\/install\.(?:sh|ps1)/u)
    assert.equal(f.runs.length, 1)
  }
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
    ["omp", "https://omp.sh/install"], ["antigravity", "https://antigravity.google/cli/install.sh"],
  ] as const) {
    const f = fixture({ files: ["/bin/bash"] })
    const terminal = await f.setup.install(input(template, { binaryPath: "/missing/old", env: { TOKEN: "sensitive-value" } }))
    assert.equal(terminal.status, "running")
    assert.equal(f.calls.length, 0)
    assert.equal(f.runs[0]!.command, "/bin/bash")
    assert.ok(f.runs[0]!.args?.join(" ").includes(url))
    assert.ok(!f.runs[0]!.args?.join(" ").includes("sensitive-value"))
    assert.equal(f.runs[0]!.env?.TOKEN, "sensitive-value")
    if (template === "omp") assert.match(f.runs[0]!.args!.at(-1)!, /\| sh -s -- --binary$/u)
  }
})

test("bundled DeepSeek login shares registration credentials with detection without moving session history", async () => {
  const directory = join(tmpdir(), "registration-login")
  const f = fixture({ directory, env: { PATH: "", DSH_HOME: "/another-registration" }, answer: async (_command, args) => args.includes("status")
    ? result(JSON.stringify({ auth: "unauthenticated" })) : result("0.2.2-rc.1") })
  await assert.rejects(f.setup.install(input("deepseek-harness")), /included with DeskFleet/u)
  const provider = input("deepseek-harness")
  await f.setup.login(provider)
  assert.equal(f.runs.length, 1)
  assert.ok(f.runs[0]!.args?.includes("login"))
  assert.equal(f.runs[0]!.env?.DSH_HOME, "/another-registration")
  assert.equal(f.runs[0]!.env?.DESKFLEET_DSH_CREDENTIALS_PATH, join(directory, "deepseek-harness", ".credentials.yaml"))
  assert.ok(f.calls.every(call => call.env.DESKFLEET_DSH_CREDENTIALS_PATH === f.runs[0]!.env?.DESKFLEET_DSH_CREDENTIALS_PATH))
  assert.deepEqual(provider.env, {})
  await f.setup.login(input("deepseek-harness", { env: { DSH_HOME: "/chosen/account" } }))
  assert.equal(f.runs[1]!.env?.DSH_HOME, "/chosen/account")
  assert.equal(f.runs[1]!.env?.DESKFLEET_DSH_CREDENTIALS_PATH, undefined)
})

test("DeepSeek login refuses missing bundled runtimes and leaves external CLI authentication alone", async () => {
  const missing = fixture({ answer: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) } })
  await assert.rejects(missing.setup.login(input("deepseek-harness")), /Reinstall DeskFleet/u)
  assert.equal(missing.runs.length, 0)
  const external = fixture({ files: ["/tools/dsh"], answer: async () => result("dsh 0.2.2-rc.1") })
  await assert.rejects(external.setup.login(input("deepseek-harness", { binaryPath: "/tools/dsh" })), /external CLI/u)
  assert.equal(external.runs.length, 0)
})

test("bundled DeepSeek login bridges the Electron host into a Windows terminal", async context => {
  configureDshRuntime(bundledDshRuntime("C:\\resources\\dsh", electronDshHost("C:\\DeskFleet\\deskfleet.exe")))
  context.after(() => configureDshRuntime(sourceDshRuntime(import.meta.url)))
  const f = fixture({ platform: "win32", directory: "C:\\registration", answer: async (_command, args) => args.includes("status")
    ? result(JSON.stringify({ auth: "unauthenticated" })) : result("0.2.2-rc.1") })
  await f.setup.login(input("deepseek-harness"))
  assert.equal(f.runs[0]!.env?.DESKFLEET_LOGIN_HOST, "C:\\DeskFleet\\deskfleet.exe")
  assert.equal(f.runs[0]!.env?.ELECTRON_RUN_AS_NODE, "1")
  assert.match(f.runs[0]!.args!.join(" "), /RedirectStandardInput/u)
  assert.match(f.runs[0]!.args!.join(" "), /ReadKey\(\$true\)/u)
  assert.match(f.runs[0]!.args!.join(" "), /login/u)
})

test("Windows login carrier hides pasted callback input and forwards cancellation through the native terminal", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  for (const [input, expected] of [["fixture-private-callback\r", 0], ["\u0003", 130]] as const) {
    const script = "let input = ''; process.stdout.write('LOGIN_READY'); process.stdin.on('data', data => { input += data; if (input.includes(String.fromCharCode(3))) process.exit(130); if (/[\\r\\n]/.test(input)) { process.stdout.write('LOGIN_RECEIVED'); process.exit(0); } })"
    const launch = interactiveProviderProcess({ command: process.execPath, args: ["-e", script],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, "win32", true)
    // ProviderSetup uses this terminal; node-pty is only a private DSH dependency
    // with a separate ConPTY process-exit and output-draining implementation.
    const terminal = await createTerminal({ ...launch, cwd: process.cwd(), cols: 100, rows: 24,
      env: Object.fromEntries(Object.entries(launch.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)) })
    let output = ""
    let sent = false
    let timeout: NodeJS.Timeout | undefined
    const diagnostic = () => `Windows login carrier (${sent ? "input sent" : "waiting for LOGIN_READY"}): ${JSON.stringify(output)}`
    try {
      const exited = (async () => {
        for (;;) {
          const event = await terminal.nextEvent()
          assert.ok(event, `Terminal ended without an exit event. ${diagnostic()}`)
          if (event.kind === "error") throw new Error(event.error)
          if (event.data) output += event.data.toString("utf8")
          if (!sent && output.includes("LOGIN_READY")) { sent = true; await terminal.write(Buffer.from(input)) }
          if (event.kind === "exit") return event.exitCode
        }
      })()
      const exitCode = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after 20 seconds. ${diagnostic()}`)), 20_000)
      })])
      assert.equal(exitCode, expected, diagnostic())
      assert.equal(sent, true)
      assert.doesNotMatch(output, /fixture-private-callback/u)
      if (expected === 0) assert.match(output, /LOGIN_RECEIVED/u)
    } finally { clearTimeout(timeout); await terminal.close() }
  }
})

test("login launches only the selected provider's dedicated login command", async () => {
  for (const [template, executable, version, expected] of [
    ["codex", "codex", "codex-cli 1.2.3", ["login", "--device-auth"]],
    ["claude-code", "claude", "2.1.200 (Claude Code)", ["auth", "login"]],
    ["cursor", "cursor-agent", "Cursor 2026.10.22", ["login"]],
    ["grok", "grok", "grok 0.1.0", ["login", "--device-auth"]],
    ["antigravity", "agy", "Antigravity CLI 1.5.3", ["acp", "--login"]],
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

test("OMP sign in opens its TUI in the setup home directory without sending a prompt", async () => {
  const f = fixture({ files: ["/tools/omp"], answer: async (_command, args) =>
    args[0] === "--version" ? result("18.13.1") : result("Usage: omp <command> [options]") })
  await f.setup.login(input("omp", { env: { OMP_PROFILE: "work" } }))
  assert.equal(f.runs[0]!.command, "/tools/omp")
  assert.deepEqual(f.runs[0]!.args, ["--allow-home"])
  assert.equal(f.runs[0]!.cwd, "/home/someone")
  assert.equal(f.runs[0]!.env?.OMP_PROFILE, "work")
  assert.deepEqual(f.calls.map(call => call.args), [["--version"], ["--help"]])
})

test("OMP Windows setup installs the standalone binary and signs in through its selected launcher", async () => {
  const directory = "C:\\User's $tools\\omp"
  const binary = `${directory}\\omp.cmd`
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const f = fixture({ platform: "win32", env: { PATH: "", SYSTEMROOT: "C:\\Windows" }, files: [binary, powershell], answer: async (_command, args) =>
    args[0] === "--version" ? result("18.13.1") : result("Usage: omp <command> [options]") })
  const provider = input("omp", { env: { PI_INSTALL_DIR: directory, TOKEN: "sensitive-value" } })
  await f.setup.install(provider)
  assert.equal(f.runs[0]!.command, powershell)
  assert.match(f.runs[0]!.args!.at(-1)!, /https:\/\/omp\.sh\/install\.ps1/u)
  assert.match(f.runs[0]!.args!.at(-1)!, /\)\)\) -Binary;/u)
  assert.equal(f.runs[0]!.env?.PI_INSTALL_DIR, directory)
  assert.equal(f.runs[0]!.env?.TOKEN, "sensitive-value")
  assert.ok(!f.runs[0]!.args!.join(" ").includes("sensitive-value"))
  await f.setup.login(provider)
  assert.equal(f.runs[1]!.command, powershell)
  assert.equal(f.runs[1]!.env?.DESKFLEET_PROVIDER_COMMAND, binary)
  assert.ok(!f.runs[1]!.args!.join(" ").includes(binary))
  assert.equal(f.runs[1]!.args!.at(-1), "& $env:DESKFLEET_PROVIDER_COMMAND '--allow-home'; exit $LASTEXITCODE")
})

test("Pi Windows setup uses the native installer and safely launches its managed shim", async () => {
  const directory = "C:\\User's $tools\\pi-agent"
  const binary = `${directory}\\bin\\pi.cmd`
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const f = fixture({ platform: "win32", env: { PATH: "", SYSTEMROOT: "C:\\Windows" }, files: [binary, powershell], answer: async (_command, args) =>
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
