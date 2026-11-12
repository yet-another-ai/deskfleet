import { usePreferredReducedMotion, useRafFn } from "@vueuse/core"
import { onScopeDispose, readonly, shallowRef, watch } from "vue"
import { createSpring, type SpringOptions, type SpringRelease } from "../services/spring.ts"

export interface UseSpringOptions extends SpringOptions {
  reducedMotion?: () => boolean
}

/** Vue adapter for the shared spring. Targets change without resetting momentum. */
export function useSpring(initial: number, options: UseSpringOptions = {}) {
  const spring = createSpring(initial, options)
  const position = shallowRef(spring.position)
  const velocity = shallowRef(spring.velocity)
  const target = shallowRef(spring.target)
  const isActive = shallowRef(false)
  const isDragging = shallowRef(false)
  const preferredMotion = usePreferredReducedMotion()
  const reducedMotion = options.reducedMotion ?? (() => preferredMotion.value === "reduce")
  let release: SpringRelease = "spring"

  function publish(): void {
    position.value = spring.position
    velocity.value = spring.velocity
    target.value = spring.target
    isActive.value = spring.isActive
    isDragging.value = spring.isDragging
  }
  const frames = useRafFn(({ delta }) => {
    spring.advance(delta / 1000)
    publish()
    if (!spring.isActive) frames.pause()
  }, { immediate: false })

  function update(): void {
    publish()
    if (spring.isActive) frames.resume()
    else frames.pause()
  }
  watch(reducedMotion, reduced => {
    if (!reduced || spring.isDragging) return
    spring.jump(release === "inertia" ? spring.position : spring.target)
    update()
  })
  onScopeDispose(() => { frames.pause(); spring.pause() })

  return {
    position: readonly(position),
    velocity: readonly(velocity),
    target: readonly(target),
    isActive: readonly(isActive),
    isDragging: readonly(isDragging),
    setTarget(value: number): void {
      release = "spring"
      if (reducedMotion() && !spring.isDragging) spring.jump(value)
      else spring.setTarget(value)
      update()
    },
    setVelocity(value: number): void {
      if (reducedMotion() && !spring.isDragging) spring.jump(spring.target)
      else spring.setVelocity(value)
      update()
    },
    advance(deltaSeconds: number): number { spring.advance(deltaSeconds); update(); return spring.position },
    pause(): void { spring.pause(); update() },
    resume(): void { spring.resume(); update() },
    jump(value: number): void { spring.jump(value); update() },
    rebase(delta: number): void { spring.rebase(delta); update() },
    startDrag(timeSeconds: number): void { spring.startDrag(timeSeconds); update() },
    dragTo(value: number, timeSeconds: number): void { spring.dragTo(value, timeSeconds); update() },
    endDrag(timeSeconds: number, mode: SpringRelease = "spring"): void {
      release = mode
      spring.endDrag(timeSeconds, mode)
      if (reducedMotion()) spring.jump(mode === "inertia" ? spring.position : spring.target)
      update()
    },
  }
}
