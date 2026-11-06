import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { antigravityInstallDirectory, antigravityInstaller } from "./antigravity-install.ts"
import { dshAccountProcess, dshRuntimeProcess } from "@deskfleet/dsh-runtime"
import { providerEnvironment } from "./provider-environment.ts"
import { antigravityLoginProcess } from "./agents/antigravity.ts"
import { AGENT_PROVIDER_TEMPLATES, providerInput, type AgentProviderInput, type AgentProviderTemplateId, type ProviderProbeResult } from "./provider-protocol.ts"
import { interactiveProviderProcess, launchProviderCommand, runProbeCommand, type ProbeCommand } from "./provider-setup-process.ts"
import type { TerminalSummary } from "./terminal-protocol.ts"
import type { TerminalRun, TerminalSessions } from "./terminals.ts"

const BUNDLED_DSH_PROBE_TIMEOUT_MS = 30_000

interface ProbeDependencies {
  directory?: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  run?: ProbeCommand
  executable?: (path: string) => Promise<boolean>
  timeoutMs?: number
}

interface Context {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
  path: typeof posix
  run: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number) => ReturnType<ProbeCommand>
  executable: (path: string) => Promise<boolean>
}

function context(input: AgentProviderInput, dependencies: ProbeDependencies, signal?: AbortSignal): Context {
  const platform = dependencies.platform ?? process.platform
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(providerEnvironment(input, dependencies.directory, platform))]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const path = platform === "win32" ? win32 : posix
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  return {
    platform, arch: dependencies.arch ?? process.arch, env, home, path, cwd: dependencies.cwd ?? process.cwd(),
    run: (command, args, env, cwd, timeoutMs) => {
      signal?.throwIfAborted()
      return (dependencies.run ?? runProbeCommand)(command, args, env, cwd, signal, timeoutMs)
    },
    executable: dependencies.executable ?? (async path => {
      try {
        if (!(await stat(path)).isFile()) return false
        await access(path, platform === "win32" ? constants.F_OK : constants.X_OK)
        return true
      } catch { return false }
    }),
  }
}

function locations(template: AgentProviderTemplateId, ctx: Context): string[] {
  const { path, home, env, platform } = ctx
  const directories: string[] = []
  if (template === "codex" && env.CODEX_INSTALL_DIR) directories.push(env.CODEX_INSTALL_DIR)
  if (template === "grok" && env.GROK_BIN_DIR) directories.push(env.GROK_BIN_DIR)
  if (template === "omp" && env.PI_INSTALL_DIR) directories.push(env.PI_INSTALL_DIR)
  if (template === "antigravity") directories.push(antigravityInstallDirectory(ctx))
  directories.push(path.join(home, ".local", "bin"))
  if (template === "grok") directories.push(path.join(home, ".grok", "bin"))
  if (template === "claude-code") directories.push(path.join(home, ".claude", "local"))
  if (template === "pi") directories.push(...npmLocations(ctx), path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"), "bin"))
  if (template === "omp") directories.push(path.join(env.BUN_INSTALL ?? path.join(home, ".bun"), "bin"))
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    if (template === "codex") directories.push(path.join(local, "Programs", "OpenAI", "Codex", "bin"))
    if (template === "cursor") directories.push(path.join(local, "cursor-agent"))
    if (template === "omp") directories.push(path.join(local, "omp"))
  } else directories.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin")
  return directories
}

function npmLocations({ path, home, env, platform }: Context): string[] {
  const prefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix
  return [
    ...(prefix ? [platform === "win32" ? prefix : path.join(prefix, "bin")] : []),
    ...(platform === "win32" ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")] : []),
  ]
}

function candidates(command: string, ctx: Context, extraDirectories: string[] = []): string[] {
  const { path, platform } = ctx
  const expanded = command.startsWith("~/") || command.startsWith("~\\") ? path.join(ctx.home, command.slice(2)) : command
  const hasDirectory = path.isAbsolute(expanded) || /[/\\]/u.test(expanded)
  const roots = hasDirectory ? [path.resolve(ctx.cwd, expanded)]
    : [...(ctx.env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean), ...extraDirectories]
      .map(directory => path.resolve(ctx.cwd, directory, expanded))
  const suffixes = platform === "win32" && !path.extname(expanded) ? [".exe", ".com", ".ps1", ".cmd", ".bat", ""] : [""]
  return [...new Set(roots.flatMap(root => suffixes.map(suffix => root + suffix)))]
}

async function findCommand(command: string, ctx: Context, extraDirectories: string[] = []): Promise<string | undefined> {
  for (const candidate of candidates(command, ctx, extraDirectories)) if (await ctx.executable(candidate)) return candidate
  return undefined
}

/** Fixed official installer endpoints; scripts handle the vendor's package selection and verification. */
async function installer(template: AgentProviderTemplateId, ctx: Context): Promise<{ command: string; args: string[] } | string> {
  if (template === "deepseek-harness") return "DeepSeek Harness is included with DeskFleet. Reinstall DeskFleet to repair its runtime, or select your own executable."
  if (template === "acp") return "Custom ACP providers use an executable you install yourself."
  if (!["x64", "arm64"].includes(ctx.arch) || !["darwin", "linux", "win32"].includes(ctx.platform)) {
    return "Automatic installation is unavailable for this operating system or architecture."
  }
  if (ctx.platform === "win32" && template !== "grok") {
    const shell = await findCommand("pwsh", ctx) ?? await findCommand("powershell", ctx, [
      win32.join(ctx.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
    ])
    if (!shell) return "PowerShell is required to run the official installer."
    if (template === "antigravity") return antigravityInstaller({ ...ctx, shell })
    if (template === "omp") return { command: shell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://omp.sh/install.ps1'))) -Binary; if ($LASTEXITCODE) { exit $LASTEXITCODE }"] }
    const url = template === "codex" ? "https://chatgpt.com/codex/install.ps1"
      : template === "claude-code" ? "https://claude.ai/install.ps1"
        : template === "pi" ? "https://pi.dev/install.ps1" : "https://cursor.com/install?win32=true"
    return { command: shell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `$ErrorActionPreference = 'Stop'; Invoke-RestMethod '${url}' | Invoke-Expression; if ($LASTEXITCODE) { exit $LASTEXITCODE }`] }
  }
  // Grok's native Windows installer runs under Git for Windows / MSYS2 Bash, not WSL.
  const bashDirectories = ctx.platform === "win32" ? [
    win32.join(ctx.env.PROGRAMFILES ?? "C:\\Program Files", "Git", "bin"),
    win32.join(ctx.env.LOCALAPPDATA ?? win32.join(ctx.home, "AppData", "Local"), "Programs", "Git", "bin"),
  ] : ["/bin", "/usr/bin"]
  const shell = ctx.platform === "win32"
    ? await findCommand("bash", { ...ctx, env: { ...ctx.env, PATH: "" } }, bashDirectories)
    : await findCommand("bash", ctx, bashDirectories)
  if (!shell) return ctx.platform === "win32" ? "Git for Windows is required to install Grok." : "Bash is required to run the official installer."
  if (template === "antigravity") return antigravityInstaller({ ...ctx, shell })
  if (template === "omp") return { command: shell, args: ["-o", "pipefail", "-c", "curl -fsSL 'https://omp.sh/install' | sh -s -- --binary"] }
  const url = template === "codex" ? "https://chatgpt.com/codex/install.sh"
    : template === "claude-code" ? "https://claude.ai/install.sh"
      : template === "cursor" ? "https://cursor.com/install"
        : template === "pi" ? "https://pi.dev/install.sh" : "https://x.ai/cli/install.sh"
  return { command: shell, args: ["-o", "pipefail", "-c", `curl -fsSL '${url}' | ${template === "codex" || template === "pi" ? "sh" : "bash"}`] }
}

function text(output: string): string {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim()
}

async function identity(template: AgentProviderTemplateId, binary: string, ctx: Context): Promise<string | undefined> {
  if (template === "antigravity" && ctx.platform === "win32"
    && /^agy_acp_server(?:\.exe)?$/iu.test(ctx.path.basename(binary))
    && await ctx.executable(ctx.path.join(ctx.path.dirname(binary), "localharness_external.exe"))) {
    return "Antigravity ACP"
  }
  const result = await ctx.run(binary, ["--version"], ctx.env, ctx.home)
  if (result.code !== 0) return undefined
  const version = text(`${result.stdout}\n${result.stderr}`)
  if (template === "antigravity") {
    if (!/agy_acp_server|\bAGY ACP Server\b/iu.test(version)) return undefined
    const label = version.match(/^Build label:\s*(.+)$/mu)?.[1]
    return label ? `Antigravity ${label.slice(0, 180)}` : "Antigravity ACP"
  }
  const pattern = template === "codex" ? /\bcodex\b/iu : template === "claude-code" ? /\bclaude\b/iu
    : template === "cursor" ? /\bcursor\b/iu : template === "pi" ? /\bpi\s+-\s+AI coding assistant\b/iu
      : template === "omp" ? /\bomp\b|Oh My Pi/iu : template === "deepseek-harness" ? /\bdsh\b|DeepSeek Harness/iu : /\bgrok\b/iu
  if (!pattern.test(version)) {
    // Some CLIs print just a version; their help identifies the provider.
    const help = await ctx.run(binary, ["--help"], ctx.env, ctx.home)
    if (help.code !== 0 || !pattern.test(text(`${help.stdout}\n${help.stderr}`))) return undefined
  }
  return version.split(/\r?\n/u)[0]?.slice(0, 200)
}

async function authentication(template: AgentProviderTemplateId, binary: string, ctx: Context): Promise<ProviderProbeResult["auth"]> {
  if (template === "acp" || template === "antigravity") return "unknown"
  // DeepSeek Harness authenticates through DEEPSEEK_API_KEY (or a stored credential the CLI resolves).
  if (template === "deepseek-harness") return ctx.env.DEEPSEEK_API_KEY ? "authenticated" : "unknown"
  // Grok has no noninteractive status command; Pi and OMP authenticate individual model providers.
  if (template === "grok" || template === "pi" || template === "omp") return "unknown"
  try {
    const args = template === "codex" ? ["login", "status"] : template === "claude-code" ? ["auth", "status"] : ["status", "--format", "json"]
    const result = await ctx.run(binary, args, ctx.env, ctx.home)
    if (template === "codex") {
      const output = text(`${result.stdout}\n${result.stderr}`)
      if (/\bnot (?:logged in|authenticated)\b/iu.test(output)) return "unauthenticated"
      if (result.code === 0 && /\blogged in\b/iu.test(output)) return "authenticated"
    } else {
      const value: unknown = JSON.parse(result.stdout)
      if (value && typeof value === "object") {
        if (template === "claude-code") {
          const status = value as { apiKeySource?: unknown; apiProvider?: unknown; authMethod?: unknown }
          if (typeof status.apiKeySource === "string" && status.apiKeySource) return "authenticated"
          // Cloud backends use their own credentials; a missing Claude account does not require login.
          if (typeof status.apiProvider === "string" && status.apiProvider !== "firstParty") return "unknown"
          if (status.authMethod === "third_party") return "unknown"
        }
        const loggedIn = template === "claude-code" ? (value as { loggedIn?: unknown }).loggedIn : (value as { isAuthenticated?: unknown }).isAuthenticated
        if (typeof loggedIn === "boolean") return loggedIn ? "authenticated" : "unauthenticated"
      }
    }
  } catch { /* Old CLIs and unavailable status endpoints cannot establish authentication. */ }
  return "unknown"
}

async function deepseekAuthentication(ctx: Context): Promise<ProviderProbeResult["auth"]> {
  const launch = dshAccountProcess("status", ctx.env)
  try {
    const result = await ctx.run(launch.command, launch.args ?? [], launch.env ?? ctx.env, ctx.home, BUNDLED_DSH_PROBE_TIMEOUT_MS)
    if (result.code !== 0) return "unknown"
    const value: unknown = JSON.parse(result.stdout)
    if (value && typeof value === "object" && "auth" in value
      && (value.auth === "authenticated" || value.auth === "unauthenticated")) return value.auth
  } catch { /* An unavailable credential store is not proof of a signed-out account. */ }
  return "unknown"
}

/** Find the binary on the executing machine without initializing ACP or starting a login. */
export async function probeProvider(input: AgentProviderInput, dependencies: ProbeDependencies = {}): Promise<ProviderProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Provider detection timed out. Check the executable path and try again.")
      controller.abort(error)
      reject(error)
    }, dependencies.timeoutMs ?? (input.template === "deepseek-harness" && !input.binaryPath ? BUNDLED_DSH_PROBE_TIMEOUT_MS : 10_000))
  })
  try { return await Promise.race([probe(input, dependencies, controller.signal), deadline]) }
  finally { clearTimeout(timer!); controller.abort() }
}

async function probe(input: AgentProviderInput, dependencies: ProbeDependencies, signal: AbortSignal): Promise<ProviderProbeResult> {
  const provider = providerInput(input)
  const ctx = context(provider, dependencies, signal)
  const installation = await installer(provider.template, ctx)
  const base = {
    auth: "unknown" as const, installable: typeof installation !== "string", loginAvailable: false,
    ...(typeof installation === "string" ? { installMessage: installation } : {}),
  }
  if (provider.template === "deepseek-harness" && !provider.binaryPath) {
    const launch = dshRuntimeProcess(["--version"], ctx.env)
    try {
      const result = await ctx.run(launch.command, launch.args ?? [], launch.env ?? ctx.env, ctx.home, BUNDLED_DSH_PROBE_TIMEOUT_MS)
      if (result.code === 0 && text(result.stdout)) return {
        ...base, status: "found", version: text(result.stdout), loginAvailable: true,
        auth: await deepseekAuthentication(ctx),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, status: "missing" }
      throw error
    }
    return { ...base, status: "invalid", message: "The bundled DeepSeek runtime could not report its version. Retry detection or reinstall DeskFleet." }
  }
  const commands = provider.binaryPath ? [provider.binaryPath] : provider.template === "cursor" ? ["cursor-agent", "agent"]
    : provider.template === "antigravity" && ctx.platform === "win32" ? ["agy_acp_server.exe"]
    : [AGENT_PROVIDER_TEMPLATES.find(template => template.id === provider.template)!.defaultBinaryPath]
  let invalid = false
  let message: string | undefined
  for (const command of commands) {
    for (const binary of candidates(command, ctx, provider.binaryPath ? [] : locations(provider.template, ctx))) {
      signal.throwIfAborted()
      if (!await ctx.executable(binary)) continue
      if (provider.template === "acp") return { ...base, status: "found", binaryPath: binary }
      // These bundled adapters launch their CLI directly; Windows shell shims cannot be CODEX_PATH / CLAUDE_CODE_EXECUTABLE.
      if (ctx.platform === "win32" && (provider.template === "codex" || provider.template === "claude-code") && /\.(?:cmd|bat|ps1)$/iu.test(binary)) {
        invalid = true
        message = "Select the native .exe for this provider, or install its official native CLI."
        continue
      }
      if (ctx.platform === "win32" && provider.template === "pi" && /\.ps1$/iu.test(binary)) {
        invalid = true
        message = "Select Pi's .cmd launcher or native .exe; its ACP adapter cannot execute PowerShell scripts."
        continue
      }
      try {
        const version = await identity(provider.template, binary, ctx)
        if (version === undefined) { invalid = true; continue }
        // An explicit external dsh keeps its own launch and authentication contract.
        const loginAvailable = provider.template !== "deepseek-harness"
        return { ...base, status: "found", binaryPath: binary, version, loginAvailable,
          auth: await authentication(provider.template, binary, ctx) }
      } catch { invalid = true }
    }
  }
  return { ...base, status: invalid ? "invalid" : "missing",
    ...(invalid ? { message: message ?? "The executable could not be identified as this provider. Check its path or install the official CLI." } : {}) }
}

/** Installers and sign-in own ordinary machine terminals, independent of ACP tests. */
export class ProviderSetup {
  readonly #terminals: Pick<TerminalSessions, "run">
  readonly #dependencies: ProbeDependencies

  constructor(terminals: Pick<TerminalSessions, "run">, dependencies: ProbeDependencies = {}) {
    this.#terminals = terminals
    this.#dependencies = dependencies
  }

  probe(input: AgentProviderInput): Promise<ProviderProbeResult> { return probeProvider(input, this.#dependencies) }

  async install(input: AgentProviderInput): Promise<TerminalSummary> {
    const provider = providerInput(input)
    const ctx = context(provider, this.#dependencies)
    const launch = await installer(provider.template, ctx)
    if (typeof launch === "string") throw new Error(launch)
    return this.#run({ ...launch, env: ctx.env, cwd: ctx.home }, `${provider.name} installation`)
  }

  async login(input: AgentProviderInput): Promise<TerminalSummary> {
    const provider = providerInput(input)
    if (provider.template === "acp") throw new Error("Configure authentication through your custom ACP provider.")
    const result = await this.probe(provider)
    const ctx = context(provider, this.#dependencies)
    if (provider.template === "deepseek-harness") {
      if (provider.binaryPath) throw new Error("Use the bundled DeepSeek Harness to sign in, or configure credentials for your external CLI.")
      if (result.status !== "found") throw new Error("The bundled DeepSeek runtime is unavailable. Reinstall DeskFleet before signing in.")
      const launch = interactiveProviderProcess(dshAccountProcess("login", ctx.env), ctx.platform, true)
      return this.#run({ ...launch, cwd: ctx.home }, `${provider.name} sign in`)
    }
    if (result.status !== "found" || !result.binaryPath) throw new Error("Install or select the provider executable before signing in.")
    if (provider.template === "antigravity") {
      return this.#run({ ...antigravityLoginProcess(result.binaryPath, ctx.env, ctx.platform), cwd: ctx.home }, `${provider.name} sign in`)
    }
    // Pi and OMP use /login in their TUI; OMP needs --allow-home for this setup terminal.
    const args = provider.template === "claude-code" ? ["auth", "login"]
      : provider.template === "cursor" ? ["login"] : provider.template === "pi" ? []
        : provider.template === "omp" ? ["--allow-home"] : ["login", "--device-auth"]
    const launch = launchProviderCommand(result.binaryPath, args,
      provider.template === "cursor" ? { ...ctx.env, NO_OPEN_BROWSER: "1" } : ctx.env, ctx.platform)
    return this.#run({ ...launch, cwd: ctx.home }, `${provider.name} sign in`)
  }

  #run(launch: { command: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd: string }, title: string): Promise<TerminalSummary> {
    const options: TerminalRun = { ...launch, title, terminalId: randomUUID(), cols: 100, rows: 24,
      env: Object.fromEntries(Object.entries(launch.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)) }
    return this.#terminals.run(options)
  }
}
