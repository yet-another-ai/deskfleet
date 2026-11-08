import { useEventListener, usePointerSwipe, useRafFn } from "@vueuse/core"
import { ref, watch, type Ref } from "vue"

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
  const offset = ref(0)
  const dragging = ref(false)
  const settling = ref(false)
  let canceled = false
  let selecting = false
  let axis: "x" | "y" | undefined
  let startOffset = 0
  let lastOffset = 0
  let lastTime = 0
  let velocity = 0
  let springPosition = 0
  let springVelocity = 0
  let springStarted = 0

  // A critically damped spring preserves release velocity without oscillating.
  // Animate one shared stage, rather than updating every live view each frame.
  const { pause, resume } = useRafFn(({ timestamp }) => {
    const elapsed = (timestamp - springStarted) / 1000
    const frequency = 18
    const decay = Math.exp(-frequency * elapsed)
    const coefficient = springVelocity + frequency * springPosition
    offset.value = (springPosition + coefficient * elapsed) * decay
    const speed = (springVelocity - frequency * coefficient * elapsed) * decay
    if (Math.abs(offset.value) < 0.3 && Math.abs(speed) < 4) reset()
  }, { immediate: false })

  function reset(): void {
    pause()
    canceled = true
    dragging.value = false
    settling.value = false
    offset.value = 0
  }
  function settle(speed: number): void {
    dragging.value = false
    if (options.reducedMotion() || Math.abs(offset.value) < 0.3) { reset(); return }
    springPosition = offset.value
    springVelocity = speed * 1000
    springStarted = performance.now()
    settling.value = true
    resume()
  }
  function cancelGesture(): void {
    canceled = true
    if (dragging.value) settle(0)
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
      pause()
      settling.value = false
      dragging.value = true
      axis = undefined
      startOffset = lastOffset = offset.value
      lastTime = event.timeStamp
      velocity = 0
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
      offset.value = startOffset + distance
      const elapsed = event.timeStamp - lastTime
      if (elapsed > 0) velocity = 0.7 * (offset.value - lastOffset) / elapsed + 0.3 * velocity
      lastOffset = offset.value
      lastTime = event.timeStamp
    },
    onSwipeEnd(event) {
      if (canceled) return
      const width = options.viewport.value?.clientWidth ?? 0
      const delta = offset.value - startOffset
      const distance = Math.abs(delta)
      const releaseVelocity = event.timeStamp - lastTime > 80 ? 0 : Math.max(-3, Math.min(3, velocity))
      const step = delta < 0 ? 1 : -1
      const next = options.index() + step
      const commit = event.type !== "pointercancel" && axis === "x"
        && delta * step < 0 && next >= 0 && next < options.count()
        && (distance >= Math.min(96, width * 0.25) || (distance >= 24 && releaseVelocity * step < -0.5))
      canceled = true
      if (commit) {
        // Rebase onto the selected view without changing its screen position.
        selecting = true
        options.select(next)
        selecting = false
        offset.value += step * width
      }
      settle(event.type === "pointercancel" ? 0 : releaseVelocity)
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
  watch([options.index, options.enabled, options.reducedMotion], () => {
    if (!selecting) reset()
  }, { flush: "sync" })
  return { offset, dragging, settling }
}
