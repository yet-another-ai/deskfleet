import { useEventListener, usePointerSwipe } from "@vueuse/core"
import { watch, type Ref } from "vue"
import { useSpring } from "./useSpring.ts"

const PANNABLE_SELECTOR = "[data-mermaid-canvas], [data-preview-kind=\"image\"] [data-preview-canvas], [data-preview-kind=\"model\"] [data-preview-canvas], [data-office-preview]"

/** Content-area horizontal swipes navigate between views while yielding to pannable canvases. */
export function useMobileViewportSwipe(options: {
  viewport: Ref<HTMLElement | null>
  index: () => number
  count: () => number
  enabled: () => boolean
  reducedMotion: () => boolean
  select: (index: number) => void
  reveal: (index: number) => void
}) {
  const motion = useSpring(0, { positionThreshold: 0.3, velocityThreshold: 4, reducedMotion: options.reducedMotion })
  const offset = motion.position
  const dragging = motion.isDragging
  const settling = motion.isActive
  let canceled = false
  let selecting = false
  let axis: "x" | "y" | undefined
  let startOffset = 0
  let lastTime = 0

  function reset(): void {
    canceled = true
    motion.jump(0)
  }
  function settle(time: number): void {
    motion.endDrag(time, "spring")
    motion.setTarget(0)
  }
  function cancelGesture(): void {
    canceled = true
    if (dragging.value) settle(performance.now() / 1000)
  }

  const swipe = usePointerSwipe(options.viewport, {
    threshold: 6,
    pointerTypes: ["touch"],
    onSwipeStart(event) {
      const pannable = event.target instanceof Element ? event.target.closest<HTMLElement>(PANNABLE_SELECTOR) : null
      // Office widgets own their child canvas and control gestures.
      if (!pannable?.hasAttribute("data-office-preview")) pannable?.setPointerCapture?.(event.pointerId)
      canceled = !options.enabled() || !event.isPrimary || !!pannable
      if (canceled) return
      motion.startDrag(event.timeStamp / 1000)
      axis = undefined
      startOffset = offset.value
      lastTime = event.timeStamp
    },
    onSwipe(event) {
      if (canceled) return
      const dx = -swipe.distanceX.value
      const dy = swipe.distanceY.value
      axis ??= Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y"
      if (axis !== "x") return
      const width = options.viewport.value?.clientWidth ?? 0
      if (!width) return
      const step = dx < 0 ? 1 : -1
      const next = options.index() + step
      const available = dx * step < 0 && next >= 0 && next < options.count()
      if (available) options.reveal(next)
      // Boundary resistance grows with distance instead of a fixed drag ratio.
      const distance = available ? Math.max(-width, Math.min(width, dx))
        : dx * 0.5 / (1 + Math.abs(dx) / (width * 0.3))
      motion.dragTo(startOffset + distance, event.timeStamp / 1000)
      lastTime = event.timeStamp
    },
    onSwipeEnd(event) {
      if (canceled) return
      const width = options.viewport.value?.clientWidth ?? 0
      const delta = offset.value - startOffset
      const distance = Math.abs(delta)
      const releaseVelocity = event.timeStamp - lastTime > 80 ? 0 : Math.max(-3000, Math.min(3000, motion.velocity.value))
      const step = delta < 0 ? 1 : -1
      const next = options.index() + step
      const commit = event.type !== "pointercancel" && axis === "x"
        && delta * step < 0 && next >= 0 && next < options.count()
        && (distance >= Math.min(96, width * 0.25) || (distance >= 24 && releaseVelocity * step < -500))
      canceled = true
      if (commit) {
        // Rebase onto the selected view without changing its screen position or velocity.
        selecting = true
        options.select(next)
        selecting = false
        motion.rebase(step * width)
      }
      motion.setVelocity(releaseVelocity)
      settle(event.timeStamp / 1000)
    },
  })
  useEventListener(options.viewport, "touchmove", event => {
    if (!canceled && axis === "x" && event.cancelable) event.preventDefault()
  }, { passive: false })
  // pointerup also releases capture; it must not erase the settling animation.
  useEventListener(options.viewport, "lostpointercapture", cancelGesture)

  useEventListener(document, "pointerdown", event => {
    if (event.pointerType === "touch" && !event.isPrimary) cancelGesture()
  }, { capture: true })
  useEventListener(window, "resize", reset)
  watch(options.index, (next, previous) => {
    if (selecting || !options.enabled()) return
    // Button/keyboard navigation uses the same moving stage as a swipe. A
    // second selection redirects the current trajectory, including from rest.
    motion.rebase((next - previous) * (options.viewport.value?.clientWidth ?? 0))
    motion.setTarget(0)
  }, { flush: "sync" })
  watch(options.enabled, enabled => {
    if (selecting) return
    // An overview or sidebar may take over while this stage is still moving.
    // Keep settling its offset so the next surface never inherits a frozen pan.
    if (!enabled) cancelGesture()
  }, { flush: "sync" })
  watch(options.reducedMotion, reduced => { if (reduced) reset() }, { flush: "sync" })
  return { offset, dragging, settling }
}
