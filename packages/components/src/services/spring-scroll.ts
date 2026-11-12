import { animateSpring, type SpringAnimation } from "./spring.ts"

export interface SpringScroll {
  /** True only when this request reaches its destination, false when interrupted. */
  finished: Promise<boolean>
  cancel: () => void
}

interface ScrollState {
  animation: SpringAnimation
  resolve: (completed: boolean) => void
  token: object
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
export function scrollSpring(element: HTMLElement, top: number, reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches): SpringScroll {
  const destination = Math.max(0, Math.min(Math.max(0, element.scrollHeight - element.clientHeight), top))
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
    previous.animation.setTarget(destination)
    observeCompletion(previous)
    return { finished, cancel() { if (previous.token === token) previous.cancel() } }
  }

  const connected = element.isConnected
  const state: ScrollState = {
    animation: undefined!,
    resolve: resolveFinished,
    token,
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
    const targetRect = target.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    return scrollSpring(parent, parent.scrollTop + targetRect.top - parentRect.top - parent.clientTop
      + targetRect.height / 2 - parent.clientHeight / 2)
  }
  // Document scrolling is uncommon in the app shell, but can occur in embeds.
  const documentScroller = target.ownerDocument.scrollingElement
  if (documentScroller instanceof HTMLElement && documentScroller.scrollHeight > documentScroller.clientHeight) {
    const rect = target.getBoundingClientRect()
    return scrollSpring(documentScroller, documentScroller.scrollTop + rect.top + rect.height / 2 - documentScroller.clientHeight / 2)
  }
  return { finished: Promise.resolve(true), cancel() {} }
}
