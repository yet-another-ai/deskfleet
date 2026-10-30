import type { ComputedRef, InjectionKey } from "vue"
import type { FileTarget } from "../../../client/src/files.ts"

export interface AgentResourceContext { target: FileTarget; sessionId: string }
export const agentResourceContextKey: InjectionKey<ComputedRef<AgentResourceContext | undefined>> = Symbol("Agent resource context")

/** Editor locations are parsed before decoding so encoded separators stay in filenames. */
export function fileResourceLines(uri: string): { start: number; end: number } | undefined {
  const hash = uri.indexOf("#")
  const path = hash < 0 ? uri : uri.slice(0, hash)
  const fragment = hash < 0 ? undefined : uri.slice(hash + 1)
  const positiveInteger = (value: string) => /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value))
  const range = fragment?.match(/^L(\d+)(?:-L(\d+))?$/iu)
  if (range) {
    const end = range[2] ?? range[1]!
    if (!positiveInteger(range[1]!) || !positiveInteger(end) || Number(end) < Number(range[1])) return undefined
    return { start: Number(range[1]), end: Number(end) }
  }
  // A bare drive-relative reference is not a line location.
  if (!path || /^[a-z]:\d+(?::\d+)?$/iu.test(path)) return undefined
  const location = path.match(/:(\d+)(?::(\d+))?$/u)
  if (!location || !positiveInteger(location[1]!) || (location[2] !== undefined && !positiveInteger(location[2]))) return undefined
  return { start: Number(location[1]), end: Number(location[1]) }
}

/** Only filesystem references are delegated to the executing machine. */
export function isFileResource(uri: string): boolean {
  if (!uri || uri.startsWith("#") || uri.startsWith("?") || uri.startsWith("//")) return false
  if (/^[a-z]:[\\/]/iu.test(uri)) return true
  if (/^file:/iu.test(uri)) return true
  // Markdown treats a basename such as main.ts:12 as an unknown URL scheme.
  const reference = uri.split("#", 1)[0]!
  const withoutLine = reference.replace(/:[1-9]\d*(?::[1-9]\d*)?$/u, "")
  if (withoutLine !== reference && /[./\\]/u.test(withoutLine) && !/^[a-z][a-z\d+.-]*:/iu.test(withoutLine)) return true
  return !/^[a-z][a-z\d+.-]*:/iu.test(uri)
}
