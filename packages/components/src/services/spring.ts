/** All motion times are seconds; velocity is position units per second. */
export interface SpringOptions {
  duration?: number
  bounce?: number
  positionThreshold?: number
  velocityThreshold?: number
  min?: number | (() => number)
  max?: number | (() => number)
}

export type SpringRelease = "spring" | "inertia"

export const DEFAULT_SPRING_DURATION = 0.5
export const DEFAULT_SPRING_BOUNCE = 0.16

/** A scalar spring, independent of rendering and frame scheduling. */
export function createSpring(initial: number, options: SpringOptions = {}) {
  const duration = options.duration ?? DEFAULT_SPRING_DURATION
  const bounce = options.bounce ?? DEFAULT_SPRING_BOUNCE
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError("Spring duration must be positive seconds")
  if (!Number.isFinite(bounce) || bounce < 0 || bounce >= 1) throw new RangeError("Spring bounce must be between 0 (inclusive) and 1 (exclusive)")
  const omega = 2 * Math.PI / duration
  const zeta = 1 - bounce
  const positionThreshold = options.positionThreshold ?? 0.01
  const velocityThreshold = options.velocityThreshold ?? 0.05
  // Bound omega * dt as well as elapsed time: short-duration springs need
  // smaller steps than ordinary UI motion to keep Euler integration stable.
  const maxStep = Math.min(1 / 120, 0.1 / omega)
  let position = initial
  let velocity = 0
  let target = initial
  let active = false
  let dragging = false
  let mode: SpringRelease = "spring"
  let samplePosition = initial
  let sampleTime = 0

  function limit(value: number): number {
    const min = typeof options.min === "function" ? options.min() : options.min ?? -Infinity
    const max = typeof options.max === "function" ? options.max() : options.max ?? Infinity
    return Math.max(min, Math.min(max, value))
  }
  function atRest(): boolean {
    return Math.abs(velocity) <= velocityThreshold
      && (mode === "inertia" || Math.abs(position - target) <= positionThreshold)
  }
  function settle(): void {
    if (mode === "spring") position = target
    else target = position
    velocity = 0
    active = false
  }

  return {
    get position() { return position },
    get velocity() { return velocity },
    get target() { return target },
    get isActive() { return active },
    get isDragging() { return dragging },
    setTarget(value: number): void {
      target = limit(value)
      mode = "spring"
      active = !dragging && (position !== target || velocity !== 0)
    },
    setVelocity(value: number): void {
      velocity = value
      if (!dragging) active = velocity !== 0 || (mode === "spring" && position !== target)
    },
    advance(deltaSeconds: number): number {
      if (!active || dragging || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return position
      target = limit(target)
      let remaining = deltaSeconds
      while (remaining > 0 && active) {
        const dt = Math.min(remaining, maxStep)
        const acceleration = -2 * zeta * omega * velocity
          - (mode === "spring" ? omega * omega * (position - target) : 0)
        velocity += acceleration * dt
        const next = position + velocity * dt
        position = limit(next)
        // Bounds absorb momentum, so a canvas or slider never rebounds.
        if (position !== next) velocity = 0
        // Free motion has no destination. Subsequent keyboard/target input
        // starts from the current position instead of the old release point.
        if (mode === "inertia") target = position
        if (atRest()) settle()
        remaining -= dt
      }
      return position
    },
    pause(): void { active = false },
    resume(): void {
      active = !dragging && (velocity !== 0 || (mode === "spring" && position !== target))
    },
    /** Explicit initialization/reset, never used to change an animation target. */
    jump(value: number): void {
      position = target = limit(value)
      velocity = 0
      active = dragging = false
      mode = "spring"
    },
    /** Change coordinate origin without changing the visible motion. */
    rebase(delta: number): void {
      position += delta
      target += delta
      samplePosition += delta
    },
    startDrag(timeSeconds: number): void {
      active = false
      dragging = true
      samplePosition = position
      sampleTime = timeSeconds
    },
    dragTo(value: number, timeSeconds: number): void {
      position = limit(value)
      const elapsed = timeSeconds - sampleTime
      if (elapsed > 0) velocity = (position - samplePosition) / elapsed
      samplePosition = position
      sampleTime = timeSeconds
    },
    endDrag(timeSeconds: number, release: SpringRelease = "spring"): void {
      if (!dragging) return
      dragging = false
      // A pointer that has stopped before release has no remaining momentum.
      if (timeSeconds - sampleTime > 0.08) velocity = 0
      mode = release
      if (mode === "inertia") target = position
      active = velocity !== 0 || (mode === "spring" && position !== target)
    },
  }
}

export type Spring = ReturnType<typeof createSpring>

/** Imperative adapter for DOM services that do not own a Vue effect scope. */
export function animateSpring(
  initial: number,
  target: number,
  onUpdate: (position: number) => void,
  options: SpringOptions = {},
) {
  const spring = createSpring(initial, options)
  let frame: number | undefined
  let lastTime = 0
  let completed = false
  let resolveFinished: () => void = () => {}
  let finished = new Promise<void>(resolve => { resolveFinished = resolve })

  function finish(): void {
    completed = true
    resolveFinished()
  }
  function stopFrame(): void {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  function step(timestamp: number): void {
    frame = undefined
    spring.advance((timestamp - lastTime) / 1000)
    lastTime = timestamp
    onUpdate(spring.position)
    if (spring.isActive) {
      if (frame === undefined) frame = requestAnimationFrame(step)
    } else finish()
  }
  function schedule(): void {
    if (!spring.isActive) { finish(); return }
    if (frame !== undefined) return
    if (completed) {
      completed = false
      finished = new Promise<void>(resolve => { resolveFinished = resolve })
    }
    lastTime = performance.now()
    frame = requestAnimationFrame(step)
  }

  spring.setTarget(target)
  onUpdate(spring.position)
  schedule()
  return {
    spring,
    get finished() { return finished },
    cancel(): void { stopFrame(); spring.pause(); finish() },
    pause(): void { stopFrame(); spring.pause() },
    resume(): void { spring.resume(); schedule() },
    setTarget(value: number): void { spring.setTarget(value); schedule() },
  }
}

export type SpringAnimation = ReturnType<typeof animateSpring>
