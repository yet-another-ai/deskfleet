import { execFile } from "node:child_process"
import { userInfo } from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const marker = "DESKFLEET_SHELL_ENVIRONMENT_START"

/** Read exports after shell startup without interpreting startup output as variables. */
export async function loadShellEnvironment(shell?: string, signal?: AbortSignal): Promise<Record<string, string>> {
  if (process.platform === "win32") throw new Error("Loading the interactive shell environment is supported only on macOS and Linux")
  signal?.throwIfAborted()
  try {
    const executable = shell || process.env.SHELL || userInfo().shell
    if (!executable) throw new Error("Shell unavailable")
    const { stdout } = await execFileAsync(executable, ["-ilc", `printf '\\0${marker}\\0'; /usr/bin/env -0`], {
      timeout: 5_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal,
    })
    const start = stdout.lastIndexOf(`\0${marker}\0`)
    if (start < 0) throw new Error("Shell did not return its environment")
    const result: Record<string, string> = {}
    for (const entry of stdout.slice(start + marker.length + 2).split("\0")) {
      const separator = entry.indexOf("=")
      if (separator > 0) result[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
    return result
  } catch {
    signal?.throwIfAborted()
    // Shell startup output can contain secrets, so do not attach the process error.
    throw new Error("Could not load the interactive shell environment. Check the shell startup configuration.")
  }
}
