import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { isSea } from "node:sea"

export interface DshHost {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
}

export interface DshRuntime extends DshHost {
  entryPoint: string
}

/** Resolve through this package so development uses its installed dependency graph. */
export function sourceDshRuntime(resolveFrom: string | URL = import.meta.url, host: DshHost = { command: process.execPath }): DshRuntime {
  const manifest = createRequire(resolveFrom).resolve("@deskfleet/dsh-runtime/package.json")
  const entryPoint = createRequire(manifest).resolve("@deepseek-ai/dsh/lib/bin.js")
  return { ...host, entryPoint }
}

/** Packaged applications keep the upstream plugin tree outside their code bundle. */
export function bundledDshRuntime(directory: string, host: DshHost = {
  command: join(directory, "bin", process.platform === "win32" ? "node.exe" : "node"),
}): DshRuntime {
  return { ...host, entryPoint: join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") }
}

export function electronDshHost(executable: string): DshHost {
  // dsh's profile loader uses Node internals; expose them only in its child host.
  return { command: executable, args: ["--expose-internals"], env: { ELECTRON_RUN_AS_NODE: "1" } }
}

let configuredRuntime: DshRuntime | undefined

/** The embedding application selects its runtime before starting the daemon. */
export function configureDshRuntime(runtime: DshRuntime): void {
  configuredRuntime = runtime
}

export function dshRuntimeProcess(args: readonly string[], env?: NodeJS.ProcessEnv): DshHost {
  const runtime = configuredRuntime ?? (isSea() ? bundledDshRuntime(join(dirname(process.execPath), "dsh")) : sourceDshRuntime())
  return {
    command: runtime.command,
    args: [...runtime.args ?? [], runtime.entryPoint, ...args],
    env: Object.fromEntries([...Object.entries(env ?? {}), ...Object.entries(runtime.env ?? {})]
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value])),
  }
}
