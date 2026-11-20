import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import {
  commandCandidates, npmLocations, runProbeCommand, stripAnsiText,
  type AgentConfig, type ProviderSetupContext,
} from "@deskfleet/agent-core"

export const DEEPSEEK_HARNESS_IDENTITY = /\bdsh\b|DeepSeek Harness/iu

export function externalDshInstallMessage({ platform, arch }: Pick<ProviderSetupContext, "platform" | "arch">): string {
  if ((platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64")) {
    return "Install DeepSeek Harness Desktop on this machine from https://www.deepseek.com/download/, then detect again or select its dsh launcher."
  }
  return "Install Node.js 24.9 or newer and run npm install -g @deepseek-ai/dsh@0.2.2-rc.5 on this machine, then detect again or select the dsh executable."
}

async function desktopLaunchers(ctx: ProviderSetupContext): Promise<string[]> {
  if (ctx.platform === "darwin") {
    return ["/Applications", posix.join(ctx.home, "Applications")].map(directory =>
      posix.join(directory, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"))
  }
  if (ctx.platform !== "win32") return []

  // Harness's per-user installer records the user-selected path in InstallLocation.
  const command = win32.join(ctx.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'DeepSeek Harness' -and $_.InstallLocation } |
  ForEach-Object { $_.InstallLocation }`
  try {
    const result = await ctx.run(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], ctx.env, ctx.home, 3_000)
    if (result.code !== 0) return []
    return result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(path => win32.isAbsolute(path))
      .map(directory => win32.join(directory, "resources", "runtime", "cli", "bin", "dsh.cmd"))
  } catch { return [] }
}

export async function findExternalDsh(ctx: ProviderSetupContext, signal?: AbortSignal): Promise<{
  binary?: string
  version?: string
  invalid?: true
}> {
  const defaults = [ctx.path.join(ctx.home, ".local", "bin"), ...npmLocations(ctx),
    ...(ctx.platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])]
  const candidates = [...await desktopLaunchers(ctx), ...commandCandidates("dsh", ctx, defaults)]
  let invalid = false
  for (const binary of new Set(candidates)) {
    signal?.throwIfAborted()
    if (!await ctx.executable(binary)) continue
    try {
      const result = await ctx.run(binary, ["--version"], ctx.env, ctx.home, 3_000)
      if (result.code === 0) {
        const version = stripAnsiText(`${result.stdout}\n${result.stderr}`)
        const help = DEEPSEEK_HARNESS_IDENTITY.test(version) ? undefined : await ctx.run(binary, ["--help"], ctx.env, ctx.home, 3_000)
        if (!help || (help.code === 0 && DEEPSEEK_HARNESS_IDENTITY.test(stripAnsiText(`${help.stdout}\n${help.stderr}`)))) {
          return { binary, version: version.split(/\r?\n/u)[0]?.slice(0, 200) }
        }
      }
    } catch { signal?.throwIfAborted() }
    invalid = true
  }
  return invalid ? { invalid } : {}
}

export function externalDshLaunchContext(config: AgentConfig, signal?: AbortSignal): ProviderSetupContext {
  const platform = process.platform
  const env = Object.fromEntries([...Object.entries(process.env), ...Object.entries(config.env ?? {})]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  return {
    platform, arch: process.arch, env, home, cwd: process.cwd(), path: platform === "win32" ? win32 : posix,
    run: (command, args, variables, cwd, timeoutMs) => runProbeCommand(command, args, variables, cwd, signal, timeoutMs),
    async executable(binary) {
      try {
        if (!(await stat(binary)).isFile()) return false
        await access(binary, platform === "win32" ? constants.F_OK : constants.X_OK)
        return true
      } catch { return false }
    },
  }
}
