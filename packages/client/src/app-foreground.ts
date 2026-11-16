/** Native apps dispatch this when the process returns to the foreground. */
export const APP_FOREGROUND_EVENT = "deskfleet:foreground"

/** Wake signaling and peer recovery. A process switch may leave the page visible. */
export function dispatchAppForeground(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(APP_FOREGROUND_EVENT))
}
