import { join } from "node:path"
import type { AgentProviderInput } from "./provider-protocol.ts"

/** Scope new credentials without relocating Harness's existing profiles and session history. */
export function providerEnvironment(provider: AgentProviderInput, directory?: string, platform = process.platform): Record<string, string> {
  if (provider.template !== "deepseek-harness" || provider.binaryPath || !directory) return { ...provider.env }
  const value = (name: string) => Object.entries(provider.env).findLast(([key]) => platform === "win32" ? key.toUpperCase() === name : key === name)?.[1]
  if (value("DSH_HOME")) return { ...provider.env }
  return { ...provider.env, DESKFLEET_DSH_CREDENTIALS_PATH: value("DESKFLEET_DSH_CREDENTIALS_PATH") || join(directory, "deepseek-harness", ".credentials.yaml") }
}
