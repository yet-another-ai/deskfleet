import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentProcess } from "./agents/acp.ts"
import { hostedProcess } from "./agents/adapter-host.ts"
import { ICAT_ARGUMENT } from "./terminal-images.ts"

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function batchQuote(value: string): string {
  return `"${value.replaceAll("%", "%%")}"`
}

/** A real command works in child shells too, without editing any user startup files. */
export function imageLauncher(host: AgentProcess, platform: NodeJS.Platform): string {
  const argv = [host.command, ...host.args ?? []]
  const entries = Object.entries(host.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  if (platform === "win32") {
    const environment = entries.map(([key, value]) => `set ${batchQuote(`${key}=${value}`)}`)
    // Environment expansion preserves Unicode paths independently of cmd's batch-file code page.
    const command = argv.map((_, index) => `"%DESKFLEET_ICAT_ARG_${index}%"`).join(" ")
    return ["@echo off", "setlocal DisableDelayedExpansion", ...environment, `${command} %*`, ""].join("\r\n")
  }
  const environment = entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")
  return `#!/bin/sh\n${environment ? `${environment} ` : ""}exec ${argv.map(shellQuote).join(" ")} "$@"\n`
}

export async function terminalImageEnvironment(historyDirectory: string): Promise<Record<string, string>> {
  // The leading dot keeps helper files outside the terminal history namespace.
  const directory = join(historyDirectory, ".shell-bin")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, process.platform === "win32" ? "icat.cmd" : "icat")
  const host = hostedProcess(ICAT_ARGUMENT)
  await writeFile(path, imageLauncher(host, process.platform), { mode: 0o700 })
  if (process.platform !== "win32") await chmod(path, 0o700)
  const inheritedPath = Object.entries(process.env).find(([key]) => process.platform === "win32" ? key.toLowerCase() === "path" : key === "PATH")?.[1] ?? ""
  const hostEnvironment = process.platform === "win32"
    ? Object.fromEntries([host.command, ...host.args ?? []].map((argument, index) => [`DESKFLEET_ICAT_ARG_${index}`, argument]))
    : {}
  return { ...hostEnvironment, PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${inheritedPath}`, TERM_PROGRAM: "deskfleet" }
}
