import { onScopeDispose } from "vue"
import { watchImmediate } from "@vueuse/core"
import type { AccountUser } from "@deskfleet/client/central"
import { setErrorReportingUser } from "../services/error-reporting.ts"

/** The document's account owner binds identity for all of its Vue applications. */
export function useErrorReportingUser(user: () => AccountUser | undefined): void {
  watchImmediate([() => user()?.id, () => user()?.email], ([id, email]) => {
    setErrorReportingUser(id ? { id, email } : undefined)
  }, { flush: "sync" })
  onScopeDispose(() => setErrorReportingUser())
}
