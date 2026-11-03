import { CentralRequestError } from "./request-diagnostics.ts"

export type CentralErrorReporter = (error: CentralRequestError) => void

/** Report at the public API boundary, after internal recovery (such as an expired login). */
export function reportingCentral<T extends object>(api: T, report: CentralErrorReporter): T {
  function failure(error: unknown): never {
    if (error instanceof CentralRequestError) {
      try { report(error) } catch { /* Reporting must not replace the request failure. */ }
    }
    throw error
  }
  return new Proxy(api, {
    get(target, property) {
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
