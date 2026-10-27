import { computed, shallowRef } from "vue"
import { recentAuthenticationRequired } from "@deskfleet/client/account-security"

/** The person closed the confirmation prompt; the action was not attempted again. */
export class RecentAuthenticationCancelled extends Error {}

/** Text for a failed action, or nothing when the person cancelled confirmation. */
export function failureMessage(reason: unknown): string | undefined {
  if (reason instanceof RecentAuthenticationCancelled) return undefined
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Runs a security-sensitive action and, when the server asks for recent
 * authentication, waits for the page's confirmation dialog before retrying once.
 */
export function useRecentAuthentication() {
  const pending = shallowRef<{ resolve(): void; reject(reason: Error): void }>()
  async function confirmed<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (reason) {
      if (!recentAuthenticationRequired(reason)) throw reason
      await new Promise<void>((resolve, reject) => { pending.value = { resolve, reject } })
      return await action()
    }
  }
  function settle(ok: boolean): void {
    const prompt = pending.value
    pending.value = undefined
    if (ok) prompt?.resolve()
    else prompt?.reject(new RecentAuthenticationCancelled())
  }
  return { prompting: computed(() => !!pending.value), confirmed, settle }
}
export type RecentAuthentication = ReturnType<typeof useRecentAuthentication>
