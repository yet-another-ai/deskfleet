import { onScopeDispose, watch } from "vue"
import { useSpring } from "./useSpring.ts"

/** Native range keyboard semantics, animated track clicks and bounded drag inertia. */
export function useInertialRange(options: {
  value: () => number
  min: number
  max: number
  enabled?: () => boolean
  preview: (value: number) => void
  commit: (value: number) => void | Promise<void>
  afterCommit?: (value: number) => void
}) {
  const motion = useSpring(options.value(), { bounce: 0, min: options.min, max: options.max })
  let pointer: number | undefined
  let commitPending = false
  let editing = false
  let pressedAt = 0
  let generation = 0
  let saving = false
  let pendingCommit: { value: number; generation: number } | undefined

  async function saveLatest(): Promise<void> {
    if (saving || !pendingCommit) return
    const pending = pendingCommit
    pendingCommit = undefined
    if (pending.generation !== generation) return
    saving = true
    try {
      await options.commit(pending.value)
      // A completed write owns its preview only until the next input or reset.
      if (pending.generation === generation) options.afterCommit?.(pending.value)
    } finally {
      saving = false
      void saveLatest()
    }
  }

  function commitWhenStopped(): void {
    if (!commitPending || pointer !== undefined || motion.isActive.value) return
    commitPending = false
    editing = false
    pendingCommit = { value: motion.position.value, generation }
    void saveLatest()
  }
  watch(motion.position, value => {
    if (pointer !== undefined || editing || commitPending) options.preview(value)
  }, { flush: "sync" })
  watch(motion.isActive, commitWhenStopped, { flush: "post" })
  watch(options.value, value => {
    // Our live preview already matches the motion; an external reset replaces it.
    if (value === motion.position.value) return
    generation++
    pointer = undefined
    commitPending = false
    editing = false
    motion.jump(value)
  }, { flush: "sync" })
  if (options.enabled) watch(options.enabled, enabled => {
    if (enabled) return
    generation++
    pointer = undefined
    commitPending = false
    editing = false
    motion.jump(options.value())
  }, { flush: "sync" })
  onScopeDispose(() => { generation++; pendingCommit = undefined })

  function pointerValue(event: PointerEvent): number {
    const element = event.currentTarget as HTMLInputElement
    const rect = element.getBoundingClientRect()
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0
    return options.min + ratio * (options.max - options.min)
  }
  function startDrag(event: PointerEvent): void {
    const element = event.currentTarget as HTMLInputElement
    if (event.button !== 0 || element.disabled || pointer !== undefined) return
    generation++
    event.preventDefault()
    element.focus()
    pointer = event.pointerId
    pressedAt = event.timeStamp / 1000
    commitPending = false
    editing = true
    // A track click starts at the rendered thumb instead of snapping to the click.
    motion.setTarget(pointerValue(event))
    element.setPointerCapture?.(event.pointerId)
  }
  function moveDrag(event: PointerEvent): void {
    if (pointer !== event.pointerId) return
    if (!motion.isDragging.value) motion.startDrag(pressedAt)
    motion.dragTo(pointerValue(event), event.timeStamp / 1000)
  }
  function endDrag(event: PointerEvent): void {
    if (pointer !== event.pointerId) return
    pointer = undefined
    commitPending = true
    if (motion.isDragging.value) motion.endDrag(event.timeStamp / 1000, "inertia")
    commitWhenStopped()
    const element = event.currentTarget as HTMLInputElement
    if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
  }
  function onInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    generation++
    commitPending = false
    editing = true
    motion.setTarget(value)
    // Native input has already moved its thumb; render the current spring frame.
    ;(event.target as HTMLInputElement).value = String(motion.position.value)
  }
  function onChange(): void {
    commitPending = true
    commitWhenStopped()
  }
  function onKeydown(event: KeyboardEvent): void {
    const element = event.currentTarget as HTMLInputElement
    const step = Number(element.step) || 1
    const targets: Record<string, number> = {
      ArrowRight: motion.target.value + step,
      ArrowUp: motion.target.value + step,
      ArrowLeft: motion.target.value - step,
      ArrowDown: motion.target.value - step,
      Home: options.min,
      End: options.max,
    }
    const value = targets[event.key]
    if (value === undefined || element.disabled) return
    generation++
    event.preventDefault()
    editing = commitPending = true
    motion.setTarget(value)
    commitWhenStopped()
  }

  return { value: motion.position, startDrag, moveDrag, endDrag, onInput, onChange, onKeydown }
}
