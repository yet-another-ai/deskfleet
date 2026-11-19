import {
  clampQuota, connectAcpProcess, jsonVersionParser, launchProviderCommand, resolveBashScriptInstaller,
  resolvePowerShellScriptInstaller, runUsageJsonCommand, supportsAutoInstallPlatform,
  UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
  type AgentProvider, type AgentProviderPlugin, type AgentQuotaItem,
} from "@deskfleet/agent-core"
import { parseOmpComposerSkill } from "./protocol.ts"

export { parseOmpComposerSkill }

interface OmpAmount {
  used?: number | null
  limit?: number | null
  unit?: string | null
  usedFraction?: number | null
  remainingFraction?: number | null
}

function ompRemaining(amount?: OmpAmount | null): number | undefined {
  if (!amount) return undefined
  if (typeof amount.usedFraction === "number") return 1 - amount.usedFraction
  if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    return (amount.limit - amount.used) / amount.limit
  }
  if (amount.unit === "percent" && typeof amount.used === "number") return (100 - amount.used) / 100
  if (typeof amount.remainingFraction === "number") return amount.remainingFraction
  return undefined
}

/** Parses `omp usage --json` output into quota buckets. */
export function parseOmpUsage(stdout: string): AgentQuotaItem[] {
  const payload = JSON.parse(stdout.trim()) as {
    error?: string
    reports?: {
      provider?: string
      error?: string
      limits?: { id?: string; label?: string; amount?: OmpAmount | null; window?: { label?: string; resetsAt?: number | null } | null }[]
    }[]
  }
  if (payload.error?.trim()) throw new Error(payload.error.trim())

  const items: AgentQuotaItem[] = []
  let firstError: string | undefined
  for (const [index, report] of (payload.reports ?? []).entries()) {
    firstError ??= report.error?.trim() || undefined
    const group = report.provider?.trim() || undefined
    for (const limit of report.limits ?? []) {
      const remaining = ompRemaining(limit.amount)
      const label = limit.label?.trim() || limit.window?.label?.trim() || limit.id?.trim()
      if (remaining === undefined || !label) continue
      items.push({
        id: `${index}:${limit.id?.trim() || label}`,
        label,
        ...(group ? { group } : {}),
        remaining: clampQuota(remaining),
        ...(typeof limit.window?.resetsAt === "number" ? { resetsAt: new Date(limit.window.resetsAt).toISOString() } : {}),
      })
    }
  }
  if (!items.length && firstError) throw new Error(firstError)
  return items
}

/** Oh My Pi serves ACP directly and uses its existing local credentials. */
export const ompProvider: AgentProvider = {
  id: "omp",
  connect(config, client) {
    return connectAcpProcess(launchProviderCommand(config.binaryPath || "omp", ["acp"], config.env), client)
  },
  async readUsage(config, signal) {
    return parseOmpUsage(await runUsageJsonCommand(config.binaryPath || "omp", ["usage", "--json"], config.env, signal))
  },
}

export const ompPlugin: AgentProviderPlugin<"omp"> = {
  id: "omp",
  template: { id: "omp", name: "Oh My Pi", defaultBinaryPath: "omp", supportsUsage: true },
  provider: ompProvider,
  parseComposerSkill: parseOmpComposerSkill,
  setup: {
    searchDirectories(ctx) {
      const directories: string[] = []
      if (ctx.env.PI_INSTALL_DIR) directories.push(ctx.env.PI_INSTALL_DIR)
      directories.push(ctx.path.join(ctx.env.BUN_INSTALL ?? ctx.path.join(ctx.home, ".bun"), "bin"))
      if (ctx.platform === "win32") {
        const local = ctx.env.LOCALAPPDATA ?? ctx.path.join(ctx.home, "AppData", "Local")
        directories.push(ctx.path.join(local, "omp"))
      }
      return directories
    },
    identityPattern: /\bomp\b|Oh My Pi/iu,
    async resolveInstaller(ctx) {
      if (!supportsAutoInstallPlatform(ctx)) return UNSUPPORTED_INSTALL_PLATFORM_MESSAGE
      if (ctx.platform === "win32") {
        return resolvePowerShellScriptInstaller(
          ctx,
          "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://omp.sh/install.ps1'))) -Binary; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
        )
      }
      return resolveBashScriptInstaller(ctx, "curl -fsSL 'https://omp.sh/install' | sh -s -- --binary")
    },
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      // OMP uses /login in its TUI and needs --allow-home for this setup terminal.
      return launchProviderCommand(binary, ["--allow-home"], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: (platform, arch) => ({
      url: `https://build.stencil.so/api/products/omp/latest/${platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"}-${arch === "x64" ? "x86_64" : "arm64"}?channel=stable`,
      parse: jsonVersionParser(),
    }),
  },
}
