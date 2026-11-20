import { join } from "node:path"
import {
  connectAcpProcess, interactiveProviderProcess, launchProviderCommand, stripAnsiText,
  type AgentConfig, type AgentProcess, type AgentProvider, type AgentProviderPlugin, type ProviderProbeResult,
  type ProviderSetupContext,
} from "@deskfleet/agent-core"
import { dshAccountProcess, dshAcpProcess, dshRuntimeProcess } from "@deskfleet/dsh-runtime"
import { DEEPSEEK_HARNESS_IDENTITY, externalDshInstallMessage, externalDshLaunchContext, findExternalDsh } from "./external.ts"

const BUNDLED_DSH_PROBE_TIMEOUT_MS = 30_000
let externalDefault = false

/** The standalone daemon uses the machine's Harness installation. */
export function configureExternalDeepSeekHarness(enabled = true): void {
  externalDefault = enabled
}

/**
 * DeepSeek Harness starts its automation-only ACP server with this profile.
 * `dsh acp` is the documented abbreviation for the same launch.
 */
export const DEEPSEEK_HARNESS_ACP_ARGUMENTS = ["--profile", "acp"] as const

export async function deepseekHarnessProcess(config: AgentConfig, signal?: AbortSignal): Promise<AgentProcess> {
  let binary = config.binaryPath
  if (!binary && externalDefault) {
    const ctx = externalDshLaunchContext(config, signal)
    binary = (await findExternalDsh(ctx, signal)).binary
    if (!binary) throw new Error(`DeepSeek Harness is unavailable. ${externalDshInstallMessage(ctx)}`)
  }
  return binary
    ? { ...launchProviderCommand(binary, [...DEEPSEEK_HARNESS_ACP_ARGUMENTS], config.env), cwd: config.cwd }
    : { ...dshAcpProcess(config.env), cwd: config.cwd }
}

/**
 * Launches the bundled DeepSeek Harness CLI, or an explicit executable override.
 * It speaks ACP over stdio. The bundled launcher selects the API-key route when
 * configured, or the account route after browser sign-in. Login is separate from ACP.
 */
export const deepseekHarnessProvider: AgentProvider = {
  id: "deepseek-harness",
  async connect(config, client) {
    return connectAcpProcess(await deepseekHarnessProcess(config, client.signal), client)
  },
}

/** Give each registration its own credentials when DeskFleet chooses the launcher. */
export function deepseekHarnessEnvironment(
  provider: { binaryPath?: string; env: Record<string, string> },
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (provider.binaryPath || !directory) return { ...provider.env }
  const value = (name: string) => Object.entries(provider.env).findLast(([key]) => platform === "win32" ? key.toUpperCase() === name : key === name)?.[1]
  if (value("DSH_HOME")) return { ...provider.env }
  const home = join(directory, "deepseek-harness")
  if (externalDefault) return { ...provider.env, DSH_HOME: home }
  return { ...provider.env, DESKFLEET_DSH_CREDENTIALS_PATH: value("DESKFLEET_DSH_CREDENTIALS_PATH") || join(home, ".credentials.yaml") }
}

async function deepseekBundledAuthentication(ctx: ProviderSetupContext): Promise<ProviderProbeResult["auth"]> {
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

export const deepseekHarnessPlugin: AgentProviderPlugin<"deepseek-harness"> = {
  id: "deepseek-harness",
  template: { id: "deepseek-harness", name: "DeepSeek Harness", defaultBinaryPath: "dsh" },
  provider: deepseekHarnessProvider,
  usesBundledDefaultBinary: true,
  resolveEnvironment: deepseekHarnessEnvironment,
  setup: {
    probeTimeoutMs: input => (!input.binaryPath ? BUNDLED_DSH_PROBE_TIMEOUT_MS : undefined),
    identityPattern: DEEPSEEK_HARNESS_IDENTITY,
    // An explicit external dsh keeps its own launch and authentication contract.
    loginAvailableForBinary: false,
    async probeCustom(input, ctx, base) {
      if (input.binaryPath) return undefined
      if (externalDefault) {
        const { binary, version, invalid } = await findExternalDsh(ctx)
        // Saving a discovered path would turn the default into an explicit override and lose registration scoping.
        return binary
          ? { ...base, status: "found", version, auth: ctx.env.DEEPSEEK_API_KEY ? "authenticated" : "unknown" }
          : invalid
            ? { ...base, status: "invalid", message: "No detected executable identified itself as DeepSeek Harness. Check the installation or select its dsh launcher." }
            : { ...base, status: "missing" }
      }
      const launch = dshRuntimeProcess(["--version"], ctx.env)
      try {
        // Both read-only checks must fit within the same detection deadline.
        const [result, auth] = await Promise.all([
          ctx.run(launch.command, launch.args ?? [], launch.env ?? ctx.env, ctx.home, BUNDLED_DSH_PROBE_TIMEOUT_MS),
          deepseekBundledAuthentication(ctx),
        ])
        if (result.code === 0 && stripAnsiText(result.stdout)) {
          return { ...base, status: "found", version: stripAnsiText(result.stdout), loginAvailable: true, auth }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, status: "missing" }
        throw error
      }
      return { ...base, status: "invalid", message: "The bundled DeepSeek runtime could not report its version. Retry detection or reinstall DeskFleet." }
    },
    async checkAuth(_binary, ctx) {
      // DeepSeek Harness authenticates through DEEPSEEK_API_KEY (or a stored credential the CLI resolves).
      return ctx.env.DEEPSEEK_API_KEY ? "authenticated" : "unknown"
    },
    async resolveInstaller(ctx) {
      if (externalDefault) return externalDshInstallMessage(ctx)
      return "DeepSeek Harness is included with DeskFleet. Reinstall DeskFleet to repair its runtime, or select your own executable."
    },
    resolveLogin(_binary, input, probeResult, ctx) {
      if (externalDefault) throw new Error("Configure authentication in the external DeepSeek Harness or set DEEPSEEK_API_KEY for this provider.")
      if (input.binaryPath) throw new Error("Use the bundled DeepSeek Harness to sign in, or configure credentials for your external CLI.")
      if (probeResult.status !== "found") throw new Error("The bundled DeepSeek runtime is unavailable. Reinstall DeskFleet before signing in.")
      return interactiveProviderProcess(dshAccountProcess("login", ctx.env), ctx.platform, true)
    },
  },
}
