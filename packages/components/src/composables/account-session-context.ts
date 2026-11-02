import { inject, type InjectionKey } from "vue"
import type { AccountSession } from "./useAccountSession.ts"

// Shared authentication components must read account context without initializing the app router.
export const accountSessionKey: InjectionKey<AccountSession> = Symbol("deskfleet account")

/** Undefined on authentication pages and in the local-only desktop. */
export function useAccountSession(): AccountSession | undefined {
  return inject(accountSessionKey, undefined)
}
