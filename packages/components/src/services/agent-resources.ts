import type { ComputedRef, InjectionKey } from "vue"
import type { FileTarget } from "../../../client/src/files.ts"

export interface AgentResourceContext { target: FileTarget; sessionId: string }
export const agentResourceContextKey: InjectionKey<ComputedRef<AgentResourceContext | undefined>> = Symbol("Agent resource context")

/** Only filesystem references are delegated to the executing machine. */
export function isFileResource(uri: string): boolean {
  if (!uri || uri.startsWith("#") || uri.startsWith("?") || uri.startsWith("//")) return false
  if (/^[a-z]:[\\/]/iu.test(uri)) return true
  if (/^file:/iu.test(uri)) return true
  // Markdown treats a basename such as main.ts:12 as an unknown URL scheme.
  const withoutLine = uri.replace(/:\d+(?::\d+)?$/u, "")
  if (withoutLine !== uri && /[./\\]/u.test(withoutLine) && !/^[a-z][a-z\d+.-]*:/iu.test(withoutLine)) return true
  return !/^[a-z][a-z\d+.-]*:/iu.test(uri)
}
