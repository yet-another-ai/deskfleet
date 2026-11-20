import type { AgentProcess } from "./types.ts"

let adapterHost: AgentProcess | undefined
let fallbackEntry: string | undefined

/** The embedding entry point supplies how to rerun itself before daemon startup; the adapter argument is appended. */
export function configureAdapterHost(host: AgentProcess): void {
  adapterHost = host
}

/** Daemon registers its source entry point for direct source execution when no explicit host is configured. */
export function configureAdapterFallbackEntry(entryPath: string): void {
  fallbackEntry = entryPath
}

/** Reuse the embedding runtime for bundled command-line helpers and ACP adapters. */
export function hostedProcess(argument: string): AgentProcess {
  if (adapterHost) return { ...adapterHost, args: [...adapterHost.args ?? [], argument] }
  if (!fallbackEntry) throw new Error("Adapter host is not configured")
  return { command: process.execPath, args: [fallbackEntry, argument] }
}
