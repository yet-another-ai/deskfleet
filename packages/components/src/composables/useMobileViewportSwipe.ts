import { useEventListener, usePointerSwipe } from "@vueuse/core"
import { ref, watch, type Ref } from "vue"

/** Only the content's edge strips own navigation; its body keeps native scrolling. */
export function useMobileViewportSwipe(options: {
  viewport: Ref<HTMLElement | null>
  left: Ref<HTMLElement | null>
  right: Ref<HTMLElement | null>
  index: () => number
  count: () => number
  enabled: () => boolean
  select: (index: number) => void
  reveal: (index: number) => void
}) {
  const offset = ref(0)
  const dragging = ref(false)
  let canceled = false
  let axis: "x" | "y" | undefined
  let startedAt = 0

  function reset(): void {
    canceled = true
    dragging.value = false
    offset.value = 0
  }

  for (const [target, step] of [[options.left, -1], [options.right, 1]] as const) {
    const swipe = usePointerSwipe(target, {
      threshold: 10,
      pointerTypes: ["touch"],
      onSwipeStart(event) {
        canceled = !options.enabled() || !event.isPrimary
        axis = undefined
        startedAt = event.timeStamp
      },
      onSwipe() {
        if (canceled) return
        const dx = -swipe.distanceX.value
        const dy = swipe.distanceY.value
        axis ??= Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y"
        if (axis !== "x") return
        dragging.value = true
        const width = options.viewport.value?.clientWidth ?? 0
        const next = options.index() + step
        const inward = dx * step < 0
        const available = next >= 0 && next < options.count()
        if (inward && available) options.reveal(next)
        offset.value = Math.max(-width, Math.min(width, dx)) * (inward && available ? 1 : 0.18)
      },
      onSwipeEnd(event) {
        const width = options.viewport.value?.clientWidth ?? 0
        const distance = Math.abs(offset.value)
        const velocity = distance / Math.max(1, event.timeStamp - startedAt)
        const next = options.index() + step
        const commit = !canceled && event.type !== "pointercancel" && axis === "x"
          && offset.value * step < 0 && next >= 0 && next < options.count()
          && (distance >= Math.min(96, width * 0.25) || (distance >= 24 && velocity >= 0.5))
        reset()
        if (commit) options.select(next)
      },
    })
    useEventListener(target, "lostpointercapture", reset)
  }

  // A second finger or interrupted capture cancels navigation, never commits it.
  useEventListener(document, "pointerdown", event => {
    if (event.pointerType === "touch" && !event.isPrimary) reset()
  }, { capture: true })
  useEventListener(window, "resize", reset)
  watch([options.index, options.enabled], reset)
  return { offset, dragging }
}
