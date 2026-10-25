import { useResizeObserver } from "@vueuse/core"
import { computed, ref, type Ref } from "vue"

const MARGIN = 12
const STEP = 16

/**
 * A toolbar floating over a stage that the viewer can drag, or move with the arrow
 * keys from its handle. Its position is relative to the stage and stays inside it;
 * null keeps the toolbar's default top-right placement.
 */
export function useFloatingToolbar(stage: Readonly<Ref<HTMLElement | null>>, toolbar: Readonly<Ref<HTMLElement | null>>) {
  const position = ref<{ x: number; y: number } | null>(null)
  let drag: { pointerId: number; offsetX: number; offsetY: number } | null = null

  function place(x: number, y: number): void {
    const bounds = stage.value, bar = toolbar.value
    if (!bounds || !bar) return
    const clamp = (value: number, size: number, extent: number) =>
      Math.min(Math.max(MARGIN, value), Math.max(MARGIN, extent - size - MARGIN))
    position.value = { x: clamp(x, bar.offsetWidth, bounds.clientWidth), y: clamp(y, bar.offsetHeight, bounds.clientHeight) }
  }
  function origin(): { x: number; y: number } {
    return position.value ?? { x: (stage.value?.clientWidth ?? 0) - (toolbar.value?.offsetWidth ?? 0) - MARGIN, y: MARGIN }
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return
    const start = origin()
    drag = { pointerId: event.pointerId, offsetX: event.clientX - start.x, offsetY: event.clientY - start.y }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function moveDrag(event: PointerEvent): void {
    if (drag?.pointerId === event.pointerId) place(event.clientX - drag.offsetX, event.clientY - drag.offsetY)
  }
  function endDrag(event: PointerEvent): void {
    if (drag?.pointerId === event.pointerId) drag = null
  }
  function nudge(event: KeyboardEvent): void {
    const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const)[event.key as "ArrowLeft"]
    if (!step) return
    event.preventDefault()
    const start = origin()
    place(start.x + step[0] * STEP, start.y + step[1] * STEP)
  }

  // A moved toolbar stays inside the stage when either one resizes.
  const keepInside = () => { if (position.value) place(position.value.x, position.value.y) }
  useResizeObserver(stage, keepInside)
  useResizeObserver(toolbar, keepInside)

  /** Where the toolbar's panel opens: toward the larger part of the stage. */
  const panelSide = computed(() => {
    const at = position.value, bounds = stage.value
    if (!at || !bounds) return { above: false, alignStart: false }
    const center = at.x + (toolbar.value?.offsetWidth ?? 0) / 2
    return { above: at.y > bounds.clientHeight / 2, alignStart: center < bounds.clientWidth / 2 }
  })

  return { position, startDrag, moveDrag, endDrag, nudge, panelSide }
}
