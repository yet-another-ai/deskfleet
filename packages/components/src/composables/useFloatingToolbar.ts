import { useEventListener, useResizeObserver } from "@vueuse/core"
import { computed, ref, type Ref } from "vue"
import { useSpring } from "./useSpring.ts"

const MARGIN = 12
const STEP = 16

/**
 * A toolbar floating over a stage that the viewer can drag, or move with the arrow
 * keys from its handle. Its position is relative to the stage and stays inside it;
 * null keeps the toolbar's default top-right placement.
 */
export function useFloatingToolbar(stage: Readonly<Ref<HTMLElement | null>>, toolbar: Readonly<Ref<HTMLElement | null>>) {
  const placed = ref(false)
  const maximumX = () => Math.max(MARGIN, (stage.value?.clientWidth ?? 0) - (toolbar.value?.offsetWidth ?? 0) - MARGIN)
  const maximumY = () => Math.max(MARGIN, (stage.value?.clientHeight ?? 0) - (toolbar.value?.offsetHeight ?? 0) - MARGIN)
  const x = useSpring(MARGIN, { bounce: 0, min: MARGIN, max: maximumX })
  const y = useSpring(MARGIN, { bounce: 0, min: MARGIN, max: maximumY })
  const position = computed(() => placed.value ? { x: x.position.value, y: y.position.value } : null)
  let drag: { pointerId: number; offsetX: number; offsetY: number } | null = null

  function origin(): { x: number; y: number } {
    return position.value ?? { x: (stage.value?.clientWidth ?? 0) - (toolbar.value?.offsetWidth ?? 0) - MARGIN, y: MARGIN }
  }
  function placeInitial(): void {
    if (placed.value) return
    const start = origin()
    x.jump(start.x)
    y.jump(start.y)
    placed.value = true
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || drag) return
    placeInitial()
    const start = origin()
    drag = { pointerId: event.pointerId, offsetX: event.clientX - start.x, offsetY: event.clientY - start.y }
    x.startDrag(event.timeStamp / 1000)
    y.startDrag(event.timeStamp / 1000)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function moveDrag(event: PointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return
    x.dragTo(event.clientX - drag.offsetX, event.timeStamp / 1000)
    y.dragTo(event.clientY - drag.offsetY, event.timeStamp / 1000)
  }
  function endDrag(event: PointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return
    drag = null
    x.endDrag(event.timeStamp / 1000, "inertia")
    y.endDrag(event.timeStamp / 1000, "inertia")
  }
  function nudge(event: KeyboardEvent): void {
    const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const)[event.key as "ArrowLeft"]
    if (!step) return
    event.preventDefault()
    placeInitial()
    x.setTarget(x.target.value + step[0] * STEP)
    y.setTarget(y.target.value + step[1] * STEP)
  }

  // A moved toolbar stays inside the stage when either one resizes.
  const keepInside = () => {
    if (!placed.value) return
    if (x.position.value > maximumX()) x.jump(maximumX())
    else if (x.target.value > maximumX()) x.setTarget(maximumX())
    if (y.position.value > maximumY()) y.jump(maximumY())
    else if (y.target.value > maximumY()) y.setTarget(maximumY())
  }
  useResizeObserver(stage, keepInside)
  useResizeObserver(toolbar, keepInside)
  useEventListener(toolbar, "lostpointercapture", endDrag)

  /** Where the toolbar's panel opens: toward the larger part of the stage. */
  const panelSide = computed(() => {
    const at = position.value, bounds = stage.value
    if (!at || !bounds) return { above: false, alignStart: false }
    const center = at.x + (toolbar.value?.offsetWidth ?? 0) / 2
    return { above: at.y > bounds.clientHeight / 2, alignStart: center < bounds.clientWidth / 2 }
  })

  return { position, startDrag, moveDrag, endDrag, nudge, panelSide }
}
