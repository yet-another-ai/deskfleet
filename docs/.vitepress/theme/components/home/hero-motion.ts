import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue"

/** Pointer parallax settles on demand; `active` also gates the hero's CSS motion. */
export function useHeroMotion(target: Ref<HTMLElement | undefined>, reduced: Ref<boolean>) {
  const x = ref(0)
  const y = ref(0)
  const active = ref(false)
  let element: HTMLElement | undefined
  let pointer: MediaQueryList | undefined
  let observer: IntersectionObserver | undefined
  let visible = false
  let mounted = false
  let goalX = 0
  let goalY = 0
  let frame = 0
  let last = 0

  const stop = () => {
    cancelAnimationFrame(frame)
    frame = 0
  }

  const reset = () => {
    stop()
    goalX = goalY = x.value = y.value = 0
  }

  const tick = (now: number) => {
    frame = 0
    const amount = 1 - Math.exp(-Math.min(64, now - last) / 120)
    last = now
    x.value += (goalX - x.value) * amount
    y.value += (goalY - y.value) * amount
    if (Math.abs(goalX - x.value) + Math.abs(goalY - y.value) < 0.001) {
      x.value = goalX
      y.value = goalY
      return
    }
    frame = requestAnimationFrame(tick)
  }

  const settle = () => {
    if (frame || !active.value || !pointer?.matches) return
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }

  const move = (event: PointerEvent) => {
    if (!active.value || !pointer?.matches || event.pointerType === "touch" || !element) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    goalX = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1))
    goalY = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1))
    settle()
  }

  const leave = () => {
    goalX = goalY = 0
    settle()
  }

  const sync = () => {
    if (!mounted) return
    active.value = visible && document.visibilityState === "visible" && !reduced.value
    if (!active.value || !pointer?.matches) reset()
  }

  watch(reduced, sync)

  onMounted(() => {
    mounted = true
    element = target.value
    pointer = window.matchMedia("(hover: hover) and (pointer: fine)")
    pointer.addEventListener("change", sync)
    document.addEventListener("visibilitychange", sync)
    element?.addEventListener("pointermove", move, { passive: true })
    element?.addEventListener("pointerleave", leave)
    element?.addEventListener("pointercancel", leave)
    observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      sync()
    })
    if (element) observer.observe(element)
  })

  onBeforeUnmount(() => {
    mounted = false
    observer?.disconnect()
    pointer?.removeEventListener("change", sync)
    document.removeEventListener("visibilitychange", sync)
    element?.removeEventListener("pointermove", move)
    element?.removeEventListener("pointerleave", leave)
    element?.removeEventListener("pointercancel", leave)
    stop()
  })

  return { x, y, active }
}
