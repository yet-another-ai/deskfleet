import { animateSpring, type SpringAnimation } from "./spring.ts"
import { scrollSpring, type SpringScroll } from "./spring-scroll.ts"

let pendingOrigin: { rect: DOMRect; expiresAt: number } | undefined

export interface SentMessageTransition {
  cancel: () => void
  finished: Promise<void>
}

export function recordSentMessageOrigin(element: Element | null | undefined): void {
  const rect = element?.getBoundingClientRect()
  pendingOrigin = rect && rect.width > 0 && rect.height > 0
    ? { rect, expiresAt: performance.now() + 1500 }
    : undefined
}

export function clearSentMessageOrigin(): void {
  pendingOrigin = undefined
}

export function consumeSentMessageTransition(entry: HTMLElement | null | undefined, reducedMotion = false): SentMessageTransition[] {
  if (!pendingOrigin || performance.now() > pendingOrigin.expiresAt) {
    pendingOrigin = undefined
    return []
  }
  const { rect: from } = pendingOrigin
  pendingOrigin = undefined
  if (reducedMotion || !entry) return []
  const bubble = entry.querySelector<HTMLElement>("[data-user-message-bubble]")
  if (!bubble) return []

  const scroller = entry.closest<HTMLElement>("[data-session-scroll-viewport]")
  const remainingScroll = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : 0
  const previousOpacity = entry.style.opacity
  let cancelled = false
  let scroll: SpringScroll | undefined
  let morph: SentMessageTransition | undefined
  let resolveFinished: () => void = () => {}
  const finished = new Promise<void>(resolve => { resolveFinished = resolve })

  function start(): void {
    entry!.style.opacity = previousOpacity
    if (cancelled) return
    morph = animateSentMessage(entry!, bubble!, from)
    if (morph) void morph.finished.then(resolveFinished)
    else resolveFinished()
  }
  if (scroller && remainingScroll > entry.getBoundingClientRect().height + 32) {
    entry.style.opacity = "0"
    scroll = scrollSpring(scroller, scroller.scrollHeight)
    void scroll.finished.then(completed => {
      entry.style.opacity = previousOpacity
      if (completed && entry.isConnected && !cancelled) start()
      else resolveFinished()
    })
  } else {
    if (scroller && remainingScroll > 0) scroller.scrollTop = scroller.scrollHeight
    start()
  }
  return [{
    finished,
    cancel() {
      cancelled = true
      scroll?.cancel()
      morph?.cancel()
      entry.style.opacity = previousOpacity
      resolveFinished()
    },
  }]
}

function animateSentMessage(entry: HTMLElement, bubble: HTMLElement, from: DOMRect): SentMessageTransition | undefined {
  const to = bubble.getBoundingClientRect()
  if (to.width <= 0 || to.height <= 0) return
  const content = bubble.firstElementChild instanceof HTMLElement ? bubble.firstElementChild : null
  const minWidth = content?.style.minWidth ?? ""
  if (content) content.style.minWidth = `${Math.ceil(content.getBoundingClientRect().width)}px`
  const adornments = [...entry.querySelectorAll<HTMLElement>("[data-user-message-meta], [data-user-message-avatar]")]
  const bubbleProperties = ["width", "height", "margin-left", "margin-bottom", "translate", "padding-top", "padding-bottom"]
  const restoreBubble = bubbleProperties.map(name => [name, bubble.style.getPropertyValue(name)] as const)
  const restoreAdornments = adornments.map(element => ({ element, opacity: element.style.opacity, translate: element.style.translate }))
  const connected = entry.isConnected
  let cleaned = false
  let animation: SpringAnimation | undefined
  bubble.dataset.messageSending = "true"

  function cleanup(): void {
    if (cleaned) return
    cleaned = true
    delete bubble.dataset.messageSending
    if (content) content.style.minWidth = minWidth
    for (const [name, value] of restoreBubble) {
      if (value) bubble.style.setProperty(name, value)
      else bubble.style.removeProperty(name)
    }
    for (const { element, opacity, translate } of restoreAdornments) {
      element.style.opacity = opacity
      element.style.translate = translate
    }
  }
  animation = animateSpring(0, 1, progress => {
    if (connected && !entry.isConnected) { animation?.cancel(); cleanup(); return }
    const remaining = 1 - progress
    bubble.style.width = `${Math.max(0, to.width + (from.width - to.width) * remaining)}px`
    bubble.style.height = `${Math.max(0, to.height + (from.height - to.height) * remaining)}px`
    bubble.style.marginLeft = `${(to.width - from.width) * remaining}px`
    bubble.style.marginBottom = `${(to.height - from.height) * remaining}px`
    bubble.style.translate = `${(from.right - to.right) * remaining}px ${(from.top - to.top) * remaining}px`
    bubble.style.paddingTop = bubble.style.paddingBottom = `${10 + 2 * remaining}px`
    for (const element of adornments) {
      element.style.opacity = String(Math.max(0, Math.min(1, progress)))
      element.style.translate = `0 ${4 * remaining}px`
    }
  }, { positionThreshold: 0.0001, velocityThreshold: 0.001 })
  void animation.finished.then(cleanup)
  return { finished: animation.finished, cancel() { animation!.cancel(); cleanup() } }
}
