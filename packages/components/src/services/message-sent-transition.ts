import { spring, waapi } from "animejs"

const horizontalSpring = spring({ bounce: 0.28, duration: 420 })
export const SENT_MESSAGE_DURATION_MS = horizontalSpring.settlingDuration
export const SENT_MESSAGE_LIFT_DURATION_MS = 420
export const SENT_MESSAGE_EASING = waapi.convertEase(horizontalSpring.ease)
export const SENT_MESSAGE_LIFT_EASING = "cubic-bezier(0.5, 0, 0.15, 1)"

let pendingOrigin: { rect: DOMRect; expiresAt: number } | undefined

export function recordSentMessageOrigin(element: Element | null | undefined): void {
  const rect = element?.getBoundingClientRect()
  pendingOrigin = rect && rect.width > 0 && rect.height > 0
    ? { rect, expiresAt: performance.now() + 1500 }
    : undefined
}

export function clearSentMessageOrigin(): void {
  pendingOrigin = undefined
}

export function consumeSentMessageTransition(entry: HTMLElement | null | undefined, reducedMotion = false): Animation[] {
  if (!pendingOrigin || performance.now() > pendingOrigin.expiresAt) {
    pendingOrigin = undefined
    return []
  }
  const { rect: from } = pendingOrigin
  pendingOrigin = undefined
  if (reducedMotion || !entry) return []

  const bubble = entry.querySelector<HTMLElement>("[data-user-message-bubble]")
  if (!bubble || typeof bubble.animate !== "function") return []
  bubble.dataset.messageSending = "true"
  const to = bubble.getBoundingClientRect()
  if (to.width <= 0 || to.height <= 0) {
    delete bubble.dataset.messageSending
    return []
  }

  const content = bubble.firstElementChild instanceof HTMLElement ? bubble.firstElementChild : null
  if (content) content.style.minWidth = `${Math.ceil(content.getBoundingClientRect().width)}px`

  const morph = bubble.animate([
    {
      width: `${from.width}px`,
      height: `${from.height}px`,
      marginLeft: `${to.width - from.width}px`,
      marginBottom: `${to.height - from.height}px`,
      translate: `${from.right - to.right}px 0px`,
      paddingTop: "12px",
      paddingBottom: "12px",
      backgroundColor: "var(--ui-color-surface)",
      boxShadow: "inset 0 0 0 1px var(--ui-color-border), var(--ui-shadow-card)",
    },
    {
      width: `${to.width}px`,
      height: `${to.height}px`,
      marginLeft: "0px",
      marginBottom: "0px",
      translate: "0px 0px",
      paddingTop: "10px",
      paddingBottom: "10px",
      backgroundColor: "color-mix(in srgb, var(--ui-color-accent) 8%, var(--ui-color-canvas))",
      boxShadow: "inset 0 0 0 1px transparent, inset 0 1px 0 transparent, 0 1px 2px transparent, 0 2px 8px transparent",
    },
  ], { duration: SENT_MESSAGE_DURATION_MS, easing: SENT_MESSAGE_EASING })
  const lift = bubble.animate([
    { transform: `translateY(${from.top - to.top}px)` },
    { transform: "translateY(0px)" },
  ], { duration: SENT_MESSAGE_LIFT_DURATION_MS, easing: SENT_MESSAGE_LIFT_EASING })

  const cleanup = () => {
    delete bubble.dataset.messageSending
    if (content) content.style.minWidth = ""
  }
  morph.addEventListener?.("finish", cleanup, { once: true })
  morph.addEventListener?.("cancel", cleanup, { once: true })

  const adornments = [...entry.querySelectorAll<HTMLElement>("[data-user-message-meta], [data-user-message-avatar]")]
    .flatMap(el => typeof el.animate === "function" ? [el.animate([
      { opacity: 0, translate: "0 4px" },
      { opacity: 0, translate: "0 4px", offset: 0.56 },
      { opacity: 1, translate: "0 0" },
    ], { duration: SENT_MESSAGE_LIFT_DURATION_MS, easing: "ease-out" })] : [])

  return [morph, lift, ...adornments]
}
