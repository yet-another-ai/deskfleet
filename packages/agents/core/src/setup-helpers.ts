import { win32 } from "node:path"
import { stripVTControlCharacters } from "node:util"
import type { ProviderSetupContext } from "./types.ts"

const SEMVER_VERSION = /(?:^|[^0-9A-Za-z.])(?:rust-v|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?![0-9A-Za-z.])/u
const VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

export function stripAnsiText(output: string): string {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim()
}

export function npmLocations({ path, home, env, platform }: ProviderSetupContext): string[] {
  const prefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix
  return [
    ...(prefix ? [platform === "win32" ? prefix : path.join(prefix, "bin")] : []),
    ...(platform === "win32" ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")] : []),
  ]
}

export function commandCandidates(command: string, ctx: ProviderSetupContext, extraDirectories: string[] = []): string[] {
  const { path, platform } = ctx
  const expanded = command.startsWith("~/") || command.startsWith("~\\") ? path.join(ctx.home, command.slice(2)) : command
  const hasDirectory = path.isAbsolute(expanded) || /[/\\]/u.test(expanded)
  const roots = hasDirectory ? [path.resolve(ctx.cwd, expanded)]
    : [...(ctx.env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean), ...extraDirectories]
      .map(directory => path.resolve(ctx.cwd, directory, expanded))
  const suffixes = platform === "win32" && !path.extname(expanded) ? [".exe", ".com", ".ps1", ".cmd", ".bat", ""] : [""]
  return [...new Set(roots.flatMap(root => suffixes.map(suffix => root + suffix)))]
}

export async function findCommand(command: string, ctx: ProviderSetupContext, extraDirectories: string[] = []): Promise<string | undefined> {
  for (const candidate of commandCandidates(command, ctx, extraDirectories)) if (await ctx.executable(candidate)) return candidate
  return undefined
}

export async function findPowerShell(ctx: ProviderSetupContext): Promise<string | undefined> {
  return await findCommand("pwsh", ctx) ?? await findCommand("powershell", ctx, [
    win32.join(ctx.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
  ])
}

export async function findBash(ctx: ProviderSetupContext, windowsGitBash = false): Promise<string | undefined> {
  if (ctx.platform === "win32" && windowsGitBash) {
    const bashDirectories = [
      win32.join(ctx.env.PROGRAMFILES ?? "C:\\Program Files", "Git", "bin"),
      win32.join(ctx.env.LOCALAPPDATA ?? win32.join(ctx.home, "AppData", "Local"), "Programs", "Git", "bin"),
    ]
    return findCommand("bash", { ...ctx, env: { ...ctx.env, PATH: "" } }, bashDirectories)
  }
  return findCommand("bash", ctx, ["/bin", "/usr/bin"])
}

export function supportsAutoInstallPlatform(ctx: ProviderSetupContext): boolean {
  return ["x64", "arm64"].includes(ctx.arch) && ["darwin", "linux", "win32"].includes(ctx.platform)
}

export const UNSUPPORTED_INSTALL_PLATFORM_MESSAGE = "Automatic installation is unavailable for this operating system or architecture."

export async function resolvePowerShellScriptInstaller(
  ctx: ProviderSetupContext,
  script: string,
): Promise<{ command: string; args: string[] } | string> {
  const shell = await findPowerShell(ctx)
  if (!shell) return "PowerShell is required to run the official installer."
  return { command: shell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] }
}

export async function resolveBashScriptInstaller(
  ctx: ProviderSetupContext,
  script: string,
  options: { windowsGitBash?: boolean; missingMessage?: string } = {},
): Promise<{ command: string; args: string[] } | string> {
  const shell = await findBash(ctx, options.windowsGitBash)
  if (!shell) return options.missingMessage ?? "Bash is required to run the official installer."
  return { command: shell, args: ["-o", "pipefail", "-c", script] }
}

/** Standard official curl/PowerShell installer resolution for darwin, linux, and win32. */
export async function resolveStandardUrlInstaller(
  ctx: ProviderSetupContext,
  options: {
    unixUrl: string
    unixShell?: "sh" | "bash"
    windowsUrl: string
  },
): Promise<{ command: string; args: string[] } | string> {
  if (!supportsAutoInstallPlatform(ctx)) return UNSUPPORTED_INSTALL_PLATFORM_MESSAGE
  if (ctx.platform === "win32") {
    return resolvePowerShellScriptInstaller(
      ctx,
      `$ErrorActionPreference = 'Stop'; Invoke-RestMethod '${options.windowsUrl}' | Invoke-Expression; if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
    )
  }
  return resolveBashScriptInstaller(ctx, `curl -fsSL '${options.unixUrl}' | ${options.unixShell ?? "bash"}`)
}

export function extractSemverVersion(raw: string): string | undefined {
  const cleaned = stripVTControlCharacters(raw).trim()
  if (!cleaned) return undefined
  return SEMVER_VERSION.exec(cleaned)?.[1]
}

function splitVersion(version: string): [core: string, suffix?: string] {
  const dash = version.indexOf("-")
  return dash < 0 ? [version] : [version.slice(0, dash), version.slice(dash + 1)]
}

export function compareSemverVersions(current: string, latest: string): number {
  const [currentCore, currentSuffix] = splitVersion(current)
  const [latestCore, latestSuffix] = splitVersion(latest)
  const coreDiff = VERSION_COLLATOR.compare(currentCore, latestCore)
  if (coreDiff !== 0) return coreDiff
  if (!currentSuffix || !latestSuffix) return currentSuffix ? -1 : latestSuffix ? 1 : 0
  return VERSION_COLLATOR.compare(currentSuffix, latestSuffix)
}

export function jsonVersionParser(extract: (raw: string) => string | undefined = extractSemverVersion): (body: string) => string | undefined {
  return body => {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== "object") return undefined
    const { version, tag_name: tag } = parsed as { version?: unknown; tag_name?: unknown }
    const candidate = typeof version === "string" ? version : typeof tag === "string" ? tag : undefined
    return candidate ? extract(candidate) : undefined
  }
}
