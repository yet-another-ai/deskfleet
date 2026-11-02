import { useEventListener } from "@vueuse/core"

/**
 * Runs `resume` when a suspended page becomes visible again or its network
 * returns. Installed PWAs on mobile freeze timers and close peers without
 * unmounting the application.
 */
export function useConnectionResume(resume: () => void): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  useEventListener(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") resume()
  })
  useEventListener(window, "online", resume)
  useEventListener(window, "pageshow", resume)
}
