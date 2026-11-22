import { animateSpring, type SpringAnimation } from "./spring.ts"

export interface SpringScroll {
  /** True only when this request reaches its destination, false when interrupted. */
  finished: Promise<boolean>
  cancel: () => void
}

type ScrollDestination = number | (() => number | undefined)

interface ScrollState {
  animation: SpringAnimation
  resolve: (completed: boolean) => void
  token: object
  destination: ScrollDestination
  cancel: () => void
  finish: () => void
}

const scrolling = new WeakMap<HTMLElement, ScrollState>()

function observeCompletion(state: ScrollState): void {
  const finished = state.animation.finished
  void finished.then(() => {
    if (finished === state.animation.finished) state.finish()
  })
}

/** Retarget an in-flight scroll, preserving its current position and velocity. */
export function scrollSpring(element: HTMLElement, top: ScrollDestination, reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches): SpringScroll {
  const clamp = (value: number) => Math.max(0, Math.min(element.scrollHeight - element.clientHeight, value))
  const initialTop = typeof top === "function" ? top() : top
  if (initialTop === undefined) return { finished: Promise.resolve(false), cancel() {} }
  const destination = clamp(initialTop)
  const previous = scrolling.get(element)
  if (reducedMotion) {
    previous?.cancel()
    element.scrollTop = destination
    return { finished: Promise.resolve(true), cancel() {} }
  }
  const token = {}
  let resolveFinished: (completed: boolean) => void = () => {}
  const finished = new Promise<boolean>(resolve => { resolveFinished = resolve })
  if (previous) {
    previous.resolve(false)
    previous.resolve = resolveFinished
    previous.token = token
    previous.destination = top
    previous.animation.setTarget(destination)
    observeCompletion(previous)
    return { finished, cancel() { if (previous.token === token) previous.cancel() } }
  }

  const connected = element.isConnected
  const state: ScrollState = {
    animation: undefined!,
    resolve: resolveFinished,
    token,
    destination: top,
    cancel: () => complete(false),
    finish: () => complete(true),
  }
  function complete(completed: boolean): void {
    if (scrolling.get(element) !== state) return
    scrolling.delete(element)
    element.removeEventListener("wheel", state.cancel)
    element.removeEventListener("pointerdown", state.cancel)
    element.removeEventListener("keydown", onKeydown)
    state.animation.cancel()
    state.resolve(completed)
  }
  function onKeydown(event: KeyboardEvent): void {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) complete(false)
  }
  state.animation = animateSpring(element.scrollTop, destination, position => {
    if (connected && !element.isConnected) { complete(false); return }
    // Newly mounted transcript rows can move the target between animation frames.
    if (state.animation && typeof state.destination === "function") {
      const top = state.destination()
      if (top === undefined) { complete(false); return }
      const destination = clamp(top)
      if (Math.abs(destination - state.animation.spring.target) > 0.5) state.animation.spring.setTarget(destination)
    }
    element.scrollTop = position
  }, {
    bounce: 0,
    min: 0,
    max: () => Math.max(0, element.scrollHeight - element.clientHeight),
    positionThreshold: 0.3,
    velocityThreshold: 4,
  })
  scrolling.set(element, state)
  element.addEventListener("wheel", state.cancel, { passive: true })
  element.addEventListener("pointerdown", state.cancel, { passive: true })
  element.addEventListener("keydown", onKeydown)
  observeCompletion(state)
  return { finished, cancel() { if (state.token === token) state.cancel() } }
}

/** Center located conversation content using the same interruptible spring. */
export function springScrollIntoView(target: HTMLElement): SpringScroll {
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (parent.scrollHeight <= parent.clientHeight || (!/(auto|scroll|overlay)/u.test(overflow) && !parent.hasAttribute("data-session-scroll-viewport"))) continue
    const viewport = parent
    return scrollSpring(viewport, () => {
      if (!viewport.contains(target)) return undefined
      const bounds = target.getBoundingClientRect()
      return viewport.scrollTop + bounds.top - viewport.getBoundingClientRect().top - viewport.clientTop
        + bounds.height / 2 - viewport.clientHeight / 2
    })
  }
  // Document scrolling is uncommon in the app shell, but can occur in embeds.
  const documentScroller = target.ownerDocument.scrollingElement
  if (documentScroller instanceof HTMLElement && documentScroller.scrollHeight > documentScroller.clientHeight) {
    return scrollSpring(documentScroller, () => {
      if (!documentScroller.contains(target)) return undefined
      const rect = target.getBoundingClientRect()
      return documentScroller.scrollTop + rect.top + rect.height / 2 - documentScroller.clientHeight / 2
    })
  }
  return { finished: Promise.resolve(true), cancel() {} }
}
