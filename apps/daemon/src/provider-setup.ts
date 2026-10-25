import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { AGENT_PROVIDER_TEMPLATES, providerInput, type AgentProviderInput, type AgentProviderTemplateId, type ProviderProbeResult } from "./provider-protocol.ts"
import { launchProviderCommand, runProbeCommand, type ProbeCommand } from "./provider-setup-process.ts"
import type { TerminalSummary } from "./terminal-protocol.ts"
import type { TerminalRun, TerminalSessions } from "./terminals.ts"

interface ProbeDependencies {
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
  run: ProbeCommand
  executable: (path: string) => Promise<boolean>
}

function context(input: AgentProviderInput, dependencies: ProbeDependencies, signal?: AbortSignal): Context {
  const platform = dependencies.platform ?? process.platform
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(input.env)]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const path = platform === "win32" ? win32 : posix
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  return {
    platform, arch: dependencies.arch ?? process.arch, env, home, path, cwd: dependencies.cwd ?? process.cwd(),
    run: (command, args, env, cwd) => {
      signal?.throwIfAborted()
      return (dependencies.run ?? runProbeCommand)(command, args, env, cwd, signal)
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
  directories.push(path.join(home, ".local", "bin"))
  if (template === "grok") directories.push(path.join(home, ".grok", "bin"))
  if (template === "claude-code") directories.push(path.join(home, ".claude", "local"))
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    if (template === "codex") directories.push(path.join(local, "Programs", "OpenAI", "Codex", "bin"))
    if (template === "cursor") directories.push(path.join(local, "cursor-agent"))
  } else directories.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin")
  return directories
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
  if (template === "acp") return "Custom ACP providers use an executable you install yourself."
  if (!["x64", "arm64"].includes(ctx.arch) || !["darwin", "linux", "win32"].includes(ctx.platform)) {
    return "Automatic installation is unavailable for this operating system or architecture."
  }
  if (ctx.platform === "win32" && template !== "grok") {
    const shell = await findCommand("pwsh", ctx) ?? await findCommand("powershell", ctx, [
      win32.join(ctx.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
    ])
    if (!shell) return "PowerShell is required to run the official installer."
    const url = template === "codex" ? "https://chatgpt.com/codex/install.ps1"
      : template === "claude-code" ? "https://claude.ai/install.ps1" : "https://cursor.com/install?win32=true"
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
  const url = template === "codex" ? "https://chatgpt.com/codex/install.sh"
    : template === "claude-code" ? "https://claude.ai/install.sh"
      : template === "cursor" ? "https://cursor.com/install" : "https://x.ai/cli/install.sh"
  return { command: shell, args: ["-o", "pipefail", "-c", `curl -fsSL '${url}' | ${template === "codex" ? "sh" : "bash"}`] }
}

function text(output: string): string {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim()
}

async function identity(template: AgentProviderTemplateId, binary: string, ctx: Context): Promise<string | undefined> {
  const result = await ctx.run(binary, ["--version"], ctx.env, ctx.home)
  if (result.code !== 0) return undefined
  const version = text(`${result.stdout}\n${result.stderr}`)
  const pattern = template === "codex" ? /\bcodex\b/iu : template === "claude-code" ? /\bclaude\b/iu
    : template === "cursor" ? /\bcursor\b/iu : /\bgrok\b/iu
  if (!pattern.test(version)) {
    // Cursor prints just a build version. Its help identifies it, unlike Grok's `agent` alias.
    const help = await ctx.run(binary, ["--help"], ctx.env, ctx.home)
    if (help.code !== 0 || !pattern.test(text(`${help.stdout}\n${help.stderr}`))) return undefined
  }
  return version.split(/\r?\n/u)[0]?.slice(0, 200)
}

async function authentication(template: AgentProviderTemplateId, binary: string, ctx: Context): Promise<ProviderProbeResult["auth"]> {
  if (template === "acp") return "unknown"
  // Grok has no documented noninteractive status command; key presence cannot prove authentication.
  if (template === "grok") return "unknown"
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

/** Find the binary on the executing machine without initializing ACP or starting a login. */
export async function probeProvider(input: AgentProviderInput, dependencies: ProbeDependencies = {}): Promise<ProviderProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Provider detection timed out. Check the executable path and try again.")
      controller.abort(error)
      reject(error)
    }, dependencies.timeoutMs ?? 10_000)
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
  const commands = provider.binaryPath ? [provider.binaryPath] : provider.template === "cursor" ? ["cursor-agent", "agent"]
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
      try {
        const version = await identity(provider.template, binary, ctx)
        if (version === undefined) { invalid = true; continue }
        return { ...base, status: "found", binaryPath: binary, version, loginAvailable: true,
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
    if (result.status !== "found" || !result.binaryPath) throw new Error("Install or select the provider executable before signing in.")
    const ctx = context(provider, this.#dependencies)
    const args = provider.template === "claude-code" ? ["auth", "login"]
      : provider.template === "cursor" ? ["login"] : ["login", "--device-auth"]
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
