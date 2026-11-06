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
  helperEntryPoint: string
}

/** Resolve through this package so development uses its installed dependency graph. */
export function sourceDshRuntime(resolveFrom: string | URL = import.meta.url, host: DshHost = { command: process.execPath }): DshRuntime {
  const manifest = createRequire(resolveFrom).resolve("@deskfleet/dsh-runtime/package.json")
  const entryPoint = createRequire(manifest).resolve("@deepseek-ai/dsh/lib/bin.js")
  return { ...host, entryPoint, helperEntryPoint: join(dirname(manifest), "src", "helper.ts") }
}

/** Packaged applications keep the upstream plugin tree outside their code bundle. */
export function bundledDshRuntime(directory: string, host: DshHost = {
  command: join(directory, "bin", process.platform === "win32" ? "node.exe" : "node"),
}): DshRuntime {
  return { ...host, entryPoint: join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    helperEntryPoint: join(directory, "helper.js") }
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
  return runtimeProcess(undefined, args, env)
}

/** Login and probes use the same private runtime and credential home as ACP. */
export function dshAccountProcess(action: "login" | "status", env?: NodeJS.ProcessEnv): DshHost {
  return runtimeProcess(action, [], env)
}

/** Select the account route only when the shared credential resolver finds no API key. */
export function dshAcpProcess(env?: NodeJS.ProcessEnv): DshHost {
  return runtimeProcess("acp", [], env)
}

function runtimeProcess(action: "login" | "status" | "acp" | undefined, args: readonly string[], env?: NodeJS.ProcessEnv): DshHost {
  const runtime = configuredRuntime ?? (isSea() ? bundledDshRuntime(join(dirname(process.execPath), "dsh")) : sourceDshRuntime())
  return {
    command: runtime.command,
    args: [...runtime.args ?? [], ...action ? [runtime.helperEntryPoint, action, runtime.entryPoint] : [runtime.entryPoint, ...args]],
    env: Object.fromEntries([...Object.entries(env ?? {}), ...Object.entries(runtime.env ?? {})]
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value])),
  }
}
