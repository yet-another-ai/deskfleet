import { computed, ref } from "vue"
import { useSpring } from "./useSpring.ts"

/** Shared image/diagram navigation: targeted zoom, direct dragging, inertial pan. */
export function usePanZoom() {
  const x = useSpring(0, { bounce: 0 })
  const y = useSpring(0, { bounce: 0 })
  const zoom = useSpring(1, { bounce: 0, min: 0.25, max: 4, positionThreshold: 0.001, velocityThreshold: 0.01 })
  const dragging = computed(() => x.isDragging.value)
  const moved = ref(false)
  let pointer: { id: number; startX: number; startY: number; originX: number; originY: number } | undefined

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || pointer) return
    pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: x.position.value, originY: y.position.value }
    moved.value = false
    x.startDrag(event.timeStamp / 1000)
    y.startDrag(event.timeStamp / 1000)
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  }

  function moveDrag(event: PointerEvent): void {
    if (pointer?.id !== event.pointerId) return
    const dx = event.clientX - pointer.startX
    const dy = event.clientY - pointer.startY
    if (Math.hypot(dx, dy) > 3) moved.value = true
    x.dragTo(pointer.originX + dx, event.timeStamp / 1000)
    y.dragTo(pointer.originY + dy, event.timeStamp / 1000)
  }

  function endDrag(event: PointerEvent): void {
    if (pointer?.id !== event.pointerId) return
    pointer = undefined
    x.endDrag(event.timeStamp / 1000, "inertia")
    y.endDrag(event.timeStamp / 1000, "inertia")
    const element = event.currentTarget as HTMLElement | null
    if (element?.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
  }

  const zoomIn = () => zoom.setTarget(Math.min(4, zoom.target.value + 0.25))
  const zoomOut = () => zoom.setTarget(Math.max(0.25, zoom.target.value - 0.25))
  function resetView(): void {
    x.setTarget(0)
    y.setTarget(0)
    zoom.setTarget(1)
  }

  return { panX: x.position, panY: y.position, scale: zoom.position, dragging, moved, startDrag, moveDrag, endDrag, zoomIn, zoomOut, resetView }
}
