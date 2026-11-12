import { execFile } from "node:child_process"
import { win32 } from "node:path"
import type { AgentProcess } from "./agents/acp.ts"

/** ConPTY needs a console carrier with redirected pipes for Electron's GUI executable. */
export function interactiveProviderProcess(host: AgentProcess, platform: NodeJS.Platform = process.platform, hideInput = false): AgentProcess {
  if (platform !== "win32" || !host.env?.ELECTRON_RUN_AS_NODE) return host
  const args = (host.args ?? []).map(arg => `"${arg.replaceAll('"', '\\"')}"`).join(" ").replaceAll("'", "''")
  // ReadKey intercepts ConPTY input without console echo. The child owns line editing
  // and Ctrl+C handling; its pipe cannot turn off echo in the parent console.
  const input = hideInput ? `$previousCtrlC = [Console]::TreatControlCAsInput
try {
  [Console]::TreatControlCAsInput = $true
  while (-not $p.WaitForExit(50)) {
    $keys = [Text.StringBuilder]::new()
    while ([Console]::KeyAvailable) { [void]$keys.Append([Console]::ReadKey($true).KeyChar) }
    if ($keys.Length) {
      $bytes = [Text.Encoding]::UTF8.GetBytes($keys.ToString())
      $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $p.StandardInput.BaseStream.Flush()
    }
  }
} finally { [Console]::TreatControlCAsInput = $previousCtrlC }` : `$in = [Console]::OpenStandardInput(); $buf = [byte[]]::new(256); $read = $null
while (-not $p.WaitForExit(50)) {
  if (-not $read) { $read = $in.ReadAsync($buf, 0, $buf.Length) }
  if ($read.IsCompleted) {
    if (($n = $read.GetAwaiter().GetResult()) -le 0) { $p.StandardInput.Close(); break }
    $p.StandardInput.BaseStream.Write($buf, 0, $n); $p.StandardInput.BaseStream.Flush(); $read = $null
  }
}`
  const script = `$psi = [Diagnostics.ProcessStartInfo]::new($env:DESKFLEET_LOGIN_HOST, '${args}')
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $psi.RedirectStandardOutput = $psi.RedirectStandardError = $true
$p = [Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$err = $p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
${input}
[void]$out.Wait(1000); [void]$err.Wait(1000); [Environment]::Exit($p.ExitCode)`
  return {
    command: win32.join(host.env.SYSTEMROOT ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-Command", script],
    env: { ...host.env, DESKFLEET_LOGIN_HOST: host.command },
  }
}

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
export type ProbeCommand = (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal, timeoutMs?: number) => Promise<ProbeCommandResult>

/** Bounded, noninteractive metadata commands; their raw output never enters provider settings. */
export const runProbeCommand: ProbeCommand = (command, args, env, cwd, signal, timeoutMs = 3_000) => new Promise((resolve, reject) => {
  const launch = launchProviderCommand(command, args, env)
  const child = execFile(launch.command, launch.args ?? [], {
    env: launch.env, cwd, signal, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed)) reject(error)
    else resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 })
  })
  child.stdin?.end()
})
