import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import {
  commandCandidates, runProbeCommand, stripAnsiText,
  type ProbeCommand, type ProviderInstallerLaunch, type ProviderSetupContext, type ProviderSetupSpec,
} from "@deskfleet/agent-core"
import { getAgentPlugin } from "./agents/registry.ts"
import { providerEnvironment } from "./provider-environment.ts"
import {
  AGENT_PROVIDER_TEMPLATES, providerInput, shellEnvironmentEnabled,
  type AgentProviderInput, type AgentProviderTemplateId, type ProviderProbeResult,
} from "./provider-protocol.ts"
import { loadShellEnvironment, SHELL_ENVIRONMENT_TIMEOUT_MS } from "./shell-environment.ts"
import type { TerminalSummary } from "./terminal-protocol.ts"
import type { TerminalRun, TerminalSessions } from "./terminals.ts"

export type { ProviderInstallerLaunch }

export interface ProbeDependencies {
  directory?: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  run?: ProbeCommand
  executable?: (path: string) => Promise<boolean>
  timeoutMs?: number
  signal?: AbortSignal
  shellEnvironment?: (signal?: AbortSignal) => Promise<Record<string, string>>
}

async function context(input: AgentProviderInput, dependencies: ProbeDependencies, signal?: AbortSignal): Promise<ProviderSetupContext> {
  const platform = dependencies.platform ?? process.platform
  const shellEnv = shellEnvironmentEnabled(input.inheritShellEnvironment, platform)
    ? await (dependencies.shellEnvironment ? dependencies.shellEnvironment(signal) : loadShellEnvironment(undefined, signal))
    : {}
  signal?.throwIfAborted()
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(shellEnv), ...Object.entries(providerEnvironment(input, dependencies.directory, platform))]
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

function searchDirectories(setup: ProviderSetupSpec | undefined, ctx: ProviderSetupContext): string[] {
  const { path, home, platform } = ctx
  return [
    ...(setup?.prioritySearchDirectories?.(ctx) ?? []),
    path.join(home, ".local", "bin"),
    ...(setup?.searchDirectories?.(ctx) ?? []),
    ...(platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]),
  ]
}

async function resolveInstaller(template: AgentProviderTemplateId, ctx: ProviderSetupContext): Promise<{ command: string; args: string[] } | string> {
  const setup = getAgentPlugin(template)?.setup
  if (!setup) return "Custom ACP providers use an executable you install yourself."
  return setup.resolveInstaller(ctx)
}

async function verifyIdentity(setup: ProviderSetupSpec, binary: string, ctx: ProviderSetupContext): Promise<string | undefined> {
  const timeoutMs = setup.identityCommandTimeoutMs
  const result = await ctx.run(binary, ["--version"], ctx.env, ctx.home, timeoutMs)
  if (result.code !== 0) return undefined
  const version = stripAnsiText(`${result.stdout}\n${result.stderr}`)
  if (!setup.identityPattern.test(version)) {
    // Some CLIs print just a version; their help identifies the provider.
    const help = await ctx.run(binary, ["--help"], ctx.env, ctx.home, timeoutMs)
    if (help.code !== 0 || !setup.identityPattern.test(stripAnsiText(`${help.stdout}\n${help.stderr}`))) return undefined
  }
  return version.split(/\r?\n/u)[0]?.slice(0, 200)
}

/** Find the binary on the executing machine without initializing ACP or starting a login. */
export async function probeProvider(input: AgentProviderInput, dependencies: ProbeDependencies = {}): Promise<ProviderProbeResult> {
  const controller = new AbortController()
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal
  const probeTimeout = getAgentPlugin(input.template)?.setup?.probeTimeoutMs?.(input) ?? 10_000
  // Shell startup has its own bounded budget; preserve the full detection budget after it.
  const timeout = dependencies.timeoutMs ?? (probeTimeout + (shellEnvironmentEnabled(input.inheritShellEnvironment, dependencies.platform) ? SHELL_ENVIRONMENT_TIMEOUT_MS : 0))
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Provider detection timed out. Check the executable path and try again.")
      controller.abort(error)
      reject(error)
    }, timeout)
  })
  try { return await Promise.race([probe(input, dependencies, signal), deadline]) }
  finally { clearTimeout(timer!); controller.abort() }
}

export async function resolveProviderInstaller(
  input: AgentProviderInput,
  dependencies: ProbeDependencies = {},
  options: { nonInteractive?: boolean } = {},
): Promise<ProviderInstallerLaunch> {
  const provider = providerInput(input)
  const ctx = await context(provider, dependencies, dependencies.signal)
  const launch = await resolveInstaller(provider.template, ctx)
  if (typeof launch === "string") throw new Error(launch)
  const setup = getAgentPlugin(provider.template)?.setup
  if (options.nonInteractive) {
    if (setup?.nonInteractiveInstaller) {
      return { ...setup.nonInteractiveInstaller(launch, ctx), cwd: ctx.home }
    }
    const args = ctx.platform === "win32" ? ["-NonInteractive", ...launch.args] : launch.args
    return { ...launch, args, env: ctx.env, cwd: ctx.home }
  }
  return { ...launch, env: ctx.env, cwd: ctx.home }
}

async function probe(input: AgentProviderInput, dependencies: ProbeDependencies, signal: AbortSignal): Promise<ProviderProbeResult> {
  const provider = providerInput(input)
  const ctx = await context(provider, dependencies, signal)
  const setup = getAgentPlugin(provider.template)?.setup
  const installation = await resolveInstaller(provider.template, ctx)
  const base = {
    auth: "unknown" as const, installable: typeof installation !== "string", loginAvailable: false,
    ...(typeof installation === "string" ? { installMessage: installation } : {}),
  }
  if (setup?.probeCustom) {
    const custom = await setup.probeCustom(provider, ctx, base)
    if (custom) return custom
  }
  const commands = provider.binaryPath
    ? [provider.binaryPath]
    : [...(setup?.defaultCommands ?? [AGENT_PROVIDER_TEMPLATES.find(template => template.id === provider.template)!.defaultBinaryPath])]
  let invalid = false
  let message: string | undefined
  for (const command of commands) {
    for (const binary of commandCandidates(command, ctx, provider.binaryPath ? [] : searchDirectories(setup, ctx))) {
      signal.throwIfAborted()
      if (!await ctx.executable(binary)) continue
      if (!setup) return { ...base, status: "found", binaryPath: binary }
      const rejection = setup.validateBinary?.(binary, ctx)
      if (rejection) {
        invalid = true
        message = rejection
        continue
      }
      try {
        const version = await verifyIdentity(setup, binary, ctx)
        if (version === undefined) { invalid = true; continue }
        const loginAvailable = setup.loginAvailableForBinary ?? true
        return {
          ...base,
          status: "found",
          binaryPath: binary,
          version,
          loginAvailable,
          auth: setup.checkAuth ? await setup.checkAuth(binary, ctx) : "unknown",
        }
      } catch { invalid = true }
    }
  }
  return {
    ...base,
    status: invalid ? "invalid" : "missing",
    ...(invalid ? { message: message ?? "The executable could not be identified as this provider. Check its path or install the official CLI." } : {}),
  }
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
    const launch = await resolveProviderInstaller(provider, this.#dependencies)
    return this.#run(launch, `${provider.name} installation`)
  }

  async login(input: AgentProviderInput): Promise<TerminalSummary> {
    const provider = providerInput(input)
    const setup = getAgentPlugin(provider.template)?.setup
    if (!setup) throw new Error("Configure authentication through your custom ACP provider.")
    const result = await this.probe(provider)
    const ctx = await context(provider, this.#dependencies)
    const launch = setup.resolveLogin(result.status === "found" ? result.binaryPath : undefined, provider, result, ctx)
    return this.#run({ ...launch, cwd: ctx.home }, `${provider.name} sign in`)
  }

  #run(launch: { command: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd: string }, title: string): Promise<TerminalSummary> {
    const options: TerminalRun = {
      ...launch, title, terminalId: randomUUID(), cols: 100, rows: 24,
      env: Object.fromEntries(Object.entries(launch.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }
    return this.#terminals.run(options)
  }
}
