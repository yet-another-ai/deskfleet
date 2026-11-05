import { dirname, join, resolve } from "node:path"
import { isSea } from "node:sea"
import { fileURLToPath } from "node:url"
import type { AgentProcess } from "./acp.ts"

let runtimeDirectory: string | undefined

/** Electron supplies its packaged resource directory before starting the hosted daemon. */
export function configureDshRuntime(directory: string): void {
  runtimeDirectory = directory
}

export function dshRuntimeProcess(args: readonly string[], env?: NodeJS.ProcessEnv): AgentProcess {
  const directory = runtimeDirectory ?? (isSea() ? join(dirname(process.execPath), "dsh")
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/dsh-runtime/dist"))
  return {
    command: join(directory, "bin", process.platform === "win32" ? "node.exe" : "node"),
    args: [join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), ...args],
    env,
  }
}
