import { execFile } from "node:child_process"
import { win32 } from "node:path"
import type { AgentProcess } from "./agents/acp.ts"

/** Windows provider distributions also ship PowerShell and command-file launchers. */
export function launchProviderCommand(
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): AgentProcess {
  if (platform !== "win32" || !/\.(?:cmd|bat|ps1)$/iu.test(command)) return { command, args, env }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  return {
    command: win32.join(env.SYSTEMROOT ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `& $env:DESKFLEET_PROVIDER_COMMAND ${args.map(quote).join(" ")}; exit $LASTEXITCODE`],
    // The path is data, including spaces, quotes, dollar signs, and shell metacharacters.
    env: { ...env, DESKFLEET_PROVIDER_COMMAND: command },
  }
}

export interface ProbeCommandResult { stdout: string; stderr: string; code: number | null }
export type ProbeCommand = (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal) => Promise<ProbeCommandResult>

/** Bounded, noninteractive metadata commands; their raw output never enters provider settings. */
export const runProbeCommand: ProbeCommand = (command, args, env, cwd, signal) => new Promise((resolve, reject) => {
  const launch = launchProviderCommand(command, args, env)
  const child = execFile(launch.command, launch.args ?? [], {
    env: launch.env, cwd, signal, timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed)) reject(error)
    else resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 })
  })
  child.stdin?.end()
})
