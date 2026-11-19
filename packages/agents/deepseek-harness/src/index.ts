import { join } from "node:path"
import {
  connectAcpProcess, interactiveProviderProcess, launchProviderCommand, stripAnsiText,
  type AgentConfig, type AgentProcess, type AgentProvider, type AgentProviderPlugin, type ProviderProbeResult,
  type ProviderSetupContext,
} from "@deskfleet/agent-core"
import { dshAccountProcess, dshAcpProcess, dshRuntimeProcess } from "@deskfleet/dsh-runtime"

const BUNDLED_DSH_PROBE_TIMEOUT_MS = 30_000

/**
 * DeepSeek Harness starts its automation-only ACP server with this profile.
 * `dsh acp` is the documented abbreviation for the same launch.
 */
export const DEEPSEEK_HARNESS_ACP_ARGUMENTS = ["--profile", "acp"] as const

export function deepseekHarnessProcess(config: AgentConfig): AgentProcess {
  return config.binaryPath
    ? launchProviderCommand(config.binaryPath, [...DEEPSEEK_HARNESS_ACP_ARGUMENTS], config.env)
    : { ...dshAcpProcess(config.env), cwd: config.cwd }
}

/**
 * Launches the bundled DeepSeek Harness CLI, or an explicit executable override.
 * It speaks ACP over stdio. The bundled launcher selects the API-key route when
 * configured, or the account route after browser sign-in. Login is separate from ACP.
 */
export const deepseekHarnessProvider: AgentProvider = {
  id: "deepseek-harness",
  connect(config, client) {
    return connectAcpProcess(deepseekHarnessProcess(config), client)
  },
}

/** Scope new credentials without relocating Harness's existing profiles and session history. */
export function deepseekHarnessEnvironment(
  provider: { binaryPath?: string; env: Record<string, string> },
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (provider.binaryPath || !directory) return { ...provider.env }
  const value = (name: string) => Object.entries(provider.env).findLast(([key]) => platform === "win32" ? key.toUpperCase() === name : key === name)?.[1]
  if (value("DSH_HOME")) return { ...provider.env }
  return { ...provider.env, DESKFLEET_DSH_CREDENTIALS_PATH: value("DESKFLEET_DSH_CREDENTIALS_PATH") || join(directory, "deepseek-harness", ".credentials.yaml") }
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
  resolveEnvironment: deepseekHarnessEnvironment,
  setup: {
    probeTimeoutMs: input => (!input.binaryPath ? BUNDLED_DSH_PROBE_TIMEOUT_MS : undefined),
    identityPattern: /\bdsh\b|DeepSeek Harness/iu,
    // An explicit external dsh keeps its own launch and authentication contract.
    loginAvailableForBinary: false,
    async probeCustom(input, ctx, base) {
      if (input.binaryPath) return undefined
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
    async resolveInstaller() {
      return "DeepSeek Harness is included with DeskFleet. Reinstall DeskFleet to repair its runtime, or select your own executable."
    },
    resolveLogin(_binary, input, probeResult, ctx) {
      if (input.binaryPath) throw new Error("Use the bundled DeepSeek Harness to sign in, or configure credentials for your external CLI.")
      if (probeResult.status !== "found") throw new Error("The bundled DeepSeek runtime is unavailable. Reinstall DeskFleet before signing in.")
      return interactiveProviderProcess(dshAccountProcess("login", ctx.env), ctx.platform, true)
    },
  },
}
