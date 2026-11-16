import { APP_FOREGROUND_EVENT } from "@deskfleet/client/app-foreground"
import { useEventListener } from "@vueuse/core"

/**
 * Runs `resume` when a suspended page becomes visible again, its network
 * returns, or a native app returns to the foreground. Installed PWAs and
 * mobile apps freeze timers and close peers without unmounting.
 */
export function useConnectionResume(resume: () => void): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") resume()
  })
  useEventListener(window, "online", resume)
  useEventListener(window, "pageshow", resume)
  useEventListener(window, APP_FOREGROUND_EVENT, resume)
}
