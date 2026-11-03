import { CentralRequestError, type RequestTrigger } from "./request-diagnostics.ts"

export type CentralErrorReporter = (error: CentralRequestError) => void
const requestScope = Symbol("central request scope")

/** Report at the public API boundary, after internal recovery (such as an expired login). */
export function reportingCentral<T extends object>(api: T, report: CentralErrorReporter, trigger: RequestTrigger = "unknown"): T {
  function failure(error: unknown): never {
    if (error instanceof CentralRequestError) {
      error.diagnostics.trigger = trigger
      if (typeof window !== "undefined" && typeof navigator.onLine === "boolean") error.diagnostics.online = navigator.onLine
      if (typeof document !== "undefined" && ["visible", "hidden"].includes(document.visibilityState)) error.diagnostics.visibility = document.visibilityState
      try { report(error) } catch { /* Reporting must not replace the request failure. */ }
    }
    throw error
  }
  return new Proxy(api, {
    get(target, property) {
      // An immutable view, not ambient async state: concurrent calls cannot
      // change each other's trigger, and rescoping never nests reporters.
      if (property === requestScope) return (value: RequestTrigger) => reportingCentral(api, report, value)
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        try {
          // Bind the original owner so HttpCentralClient's private fields still work.
          const result: unknown = Reflect.apply(value, target, args)
          return result instanceof Promise ? result.catch(failure) : result
        } catch (error) { return failure(error) }
      }
    },
  })
}

export function withCentralRequestTrigger<T extends object>(api: T, trigger: RequestTrigger): T {
  const scoped = (api as { [requestScope]?: (trigger: RequestTrigger) => T })[requestScope]
  return scoped ? scoped(trigger) : reportingCentral(api, () => {}, trigger)
}
